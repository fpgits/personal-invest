import { generateObject } from "ai";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import {
  assets,
  events,
  theses,
  thesisAssumptions,
  thesisChanges,
  type Asset,
  type EventRow,
  type Thesis,
  type ThesisAssumption,
  type ThesisChange,
} from "@/db/schema";
import { analysisModel } from "./ai/client";
import { THESIS_CHECK_SYSTEM, THESIS_PROMPT_VERSION, THESIS_STRUCT_SYSTEM } from "./ai/prompts";
import { fundamentalsToText, getFundamentals, refreshFundamentals, type FundamentalsView } from "./fundamentals";
import { clean, stripTradeAdvice } from "./intel/extract";
import { computePortfolio } from "./portfolio";
import { fmtMoney, fmtPct, fmtQty, id } from "./utils";

/**
 * Tesis estructurada: resumen, caso alcista/bajista, SUPUESTOS medibles con
 * estado, condiciones de ruptura y que vigilar. Es la memoria por activo:
 * los eventos del motor de inteligencia proponen cambios de estado sobre
 * los supuestos, y el usuario acepta o rechaza. Nada se aplica solo.
 */

export const ASSUMPTION_STATUSES = ["on_track", "at_risk", "broken", "unknown"] as const;
export type AssumptionStatus = (typeof ASSUMPTION_STATUSES)[number];

export const STATUS_LABELS: Record<AssumptionStatus, string> = {
  on_track: "En linea",
  at_risk: "En riesgo",
  broken: "Roto",
  unknown: "Sin evidencia",
};

const assumptionDraftSchema = z.object({
  metric: z.string().min(2),
  statement: z.string().min(5),
  target: z.number().finite().nullable(),
  comparator: z.enum(["gte", "lte"]).nullable(),
  unit: z.string().nullable(),
});

export const thesisStructureSchema = z.object({
  summary: z.string().min(10),
  bull: z.array(z.string().min(3)).min(1).max(6),
  bear: z.array(z.string().min(3)).min(1).max(6),
  assumptions: z.array(assumptionDraftSchema).min(1).max(8),
  breakers: z.array(z.string().min(3)).min(1).max(6),
  watch: z.array(z.string().min(2)).max(8),
});
export type ThesisStructure = z.infer<typeof thesisStructureSchema>;

export const thesisCheckSchema = z.object({
  material: z.boolean(),
  summary: z.string(),
  assumption_updates: z
    .array(z.object({ id: z.string(), status: z.enum(ASSUMPTION_STATUSES), reason: z.string() }))
    .max(8),
  breaker_hit: z.boolean(),
  breaker: z.string().nullable(),
  conviction_delta: z.number().min(-2).max(2).transform((n) => Math.round(n)),
});
export type ThesisCheck = z.infer<typeof thesisCheckSchema>;

export type ProposalPayload = {
  assumption_updates: Array<{ id: string; status: AssumptionStatus; reason: string }>;
  breaker_hit: boolean;
  breaker: string | null;
  conviction_delta: number;
  eventHeadline?: string;
  model?: string;
  promptVersion?: string;
};

export type ThesisView = {
  thesis: Thesis;
  asset: Asset;
  structure: ThesisStructure | null;
  assumptions: ThesisAssumption[];
  pending: ThesisChange[];
  history: ThesisChange[];
  fundamentals: FundamentalsView | null;
};

// ---------------------------------------------------------------------------
// Render

/** Markdown legible: es lo que se guarda en `theses.thesis` y lee el chat. */
export function renderThesisMarkdown(
  s: ThesisStructure,
  assumptions: Array<Pick<ThesisAssumption, "metric" | "statement" | "status">> = [],
): string {
  const list = (items: string[]) => items.map((i) => `- ${i}`).join("\n");
  const asum =
    assumptions.length > 0
      ? assumptions.map((a) => `- [${STATUS_LABELS[a.status as AssumptionStatus] ?? a.status}] ${a.metric}: ${a.statement}`).join("\n")
      : s.assumptions.map((a) => `- ${a.metric}: ${a.statement}`).join("\n");
  return [
    "## Que es",
    s.summary,
    "## Caso alcista",
    list(s.bull),
    "## Caso bajista",
    list(s.bear),
    "## Supuestos",
    asum,
    "## Que la rompe",
    list(s.breakers),
    s.watch.length ? "## Que hay que vigilar" : "",
    s.watch.length ? list(s.watch) : "",
  ]
    .filter((l) => l !== "")
    .join("\n\n");
}

/**
 * Lee la estructura guardada. Es tolerante: lo que se guardo ya paso por el
 * saneado, y un texto un poco corto no debe dejar la tesis sin renderizar.
 */
export function parseStructure(raw: string | null): ThesisStructure | null {
  if (!raw) return null;
  try {
    const json = JSON.parse(raw) as unknown;
    const strict = thesisStructureSchema.safeParse(json);
    if (strict.success) return strict.data;
    if (!json || typeof json !== "object") return null;
    const o = json as Record<string, unknown>;
    const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []) as string[];
    const assumptions = (Array.isArray(o.assumptions) ? o.assumptions : [])
      .filter((a) => a && typeof a === "object")
      .map((a) => {
        const x = a as Record<string, unknown>;
        return {
          metric: String(x.metric ?? ""),
          statement: String(x.statement ?? ""),
          target: typeof x.target === "number" && Number.isFinite(x.target) ? x.target : null,
          comparator: (x.comparator === "gte" || x.comparator === "lte" ? x.comparator : null) as "gte" | "lte" | null,
          unit: typeof x.unit === "string" ? x.unit : null,
        };
      });
    if (typeof o.summary !== "string" || !o.summary.trim()) return null;
    if (assumptions.length === 0 && strs(o.bull).length === 0 && strs(o.bear).length === 0) return null;
    return {
      summary: o.summary,
      bull: strs(o.bull),
      bear: strs(o.bear),
      assumptions,
      breakers: strs(o.breakers),
      watch: strs(o.watch),
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Generacion (borrador; no guarda)

export type ThesisDraft = { structure: ThesisStructure; model: string; promptVersion: string };

export async function generateThesisDraft(asset: Asset): Promise<ThesisDraft> {
  const [portfolio, existing] = await Promise.all([
    computePortfolio().catch(() => null),
    getThesisView(asset.id),
  ]);

  // Fundamentales: si faltan o estan viejos, se intenta refrescar aqui mismo
  // (una vez, mejor esfuerzo) para que la tesis salga con numeros.
  let fundamentals = existing?.fundamentals ?? (await getFundamentals(asset.id));
  if (asset.assetClass === "equity" && (!fundamentals || Date.now() - fundamentals.updatedAt > 7 * 86400_000)) {
    await refreshFundamentals([asset]).catch(() => undefined);
    fundamentals = await getFundamentals(asset.id);
  }

  const pos = portfolio?.positions.find((p) => p.asset.id === asset.id);
  const position = pos && portfolio
    ? [
        `Posicion abierta en ${asset.symbol}: ${fmtQty(pos.quantity)} uds, coste medio ${fmtMoney(pos.avgCost, portfolio.currency)}, precio ${fmtMoney(pos.price, portfolio.currency)}, P&L ${fmtPct(pos.unrealizedPct)}, peso ${pos.weight.toFixed(1)}%.`,
      ].join("\n")
    : `Sin posicion abierta en ${asset.symbol}.`;

  const recent = await recentEventsFor(asset.id, 8);
  const eventLines = recent.map(
    (e) =>
      `- [${new Date(e.occurredAt).toISOString().slice(0, 10)}] (${e.priority}, impacto ${e.thesisImpact}) ${clean(e.headline, 160)}. Hecho: ${clean(e.fact, 300)}`,
  );

  const previous = existing?.structure
    ? [
        "Tesis previa (actualizala, no la reinventes):",
        `Resumen: ${clean(existing.structure.summary, 600)}`,
        "Supuestos:",
        ...existing.assumptions.map(
          (a) => `- ${a.metric}: ${a.statement} [estado: ${STATUS_LABELS[a.status as AssumptionStatus] ?? a.status}]`,
        ),
        `Rompe-tesis: ${existing.structure.breakers.join(" | ")}`,
      ]
    : [];

  const fundText = fundamentalsToText(fundamentals);
  const prompt = [
    `Activo: ${asset.symbol} (${clean(asset.name, 80)}), clase ${asset.assetClass}.`,
    position,
    fundText ? `Fundamentales (Finnhub): ${fundText}` : "Fundamentales: sin datos disponibles.",
    eventLines.length ? `Eventos recientes del motor de inteligencia:\n${eventLines.join("\n")}` : "",
    ...previous,
    "",
    "Devuelve la tesis estructurada.",
  ]
    .filter((l) => l !== "")
    .join("\n");

  const model = await analysisModel();
  const { object } = await generateObject({
    model,
    schema: thesisStructureSchema,
    system: THESIS_STRUCT_SYSTEM,
    prompt,
    temperature: 0.3,
    maxRetries: 1,
    abortSignal: AbortSignal.timeout(90_000),
  });

  return { structure: sanitizeStructure(object), model: model.modelId, promptVersion: THESIS_PROMPT_VERSION };
}

export function sanitizeStructure(s: ThesisStructure): ThesisStructure {
  const txt = (v: string, max: number) => stripTradeAdvice(clean(v, max));
  return {
    summary: txt(s.summary, 1200),
    bull: s.bull.map((b) => txt(b, 400)).slice(0, 6),
    bear: s.bear.map((b) => txt(b, 400)).slice(0, 6),
    assumptions: s.assumptions
      .map((a) => ({
        metric: clean(a.metric, 80),
        statement: txt(a.statement, 400),
        target: a.target !== null && Number.isFinite(a.target) ? a.target : null,
        comparator: a.comparator,
        unit: a.unit ? clean(a.unit, 12) : null,
      }))
      .slice(0, 8),
    breakers: s.breakers.map((b) => txt(b, 400)).slice(0, 6),
    watch: s.watch.map((w) => txt(w, 200)).slice(0, 8),
  };
}

// ---------------------------------------------------------------------------
// Guardado

export type SaveThesisInput = {
  assetId: string;
  structure: ThesisStructure;
  conviction?: number | null;
  horizon?: string | null;
  targetPrice?: number | null;
  generatedBy: string;
  promptVersion?: string;
};

/**
 * Guarda o actualiza. Los supuestos se casan por `metric` con los previos
 * para conservar su estado y su historial; los que desaparecen se borran.
 */
export async function saveThesis(input: SaveThesisInput): Promise<string> {
  const now = Date.now();
  const structure = sanitizeStructure(input.structure);
  const existing = await db.select().from(theses).where(eq(theses.assetId, input.assetId)).limit(1);
  const thesisId = existing[0]?.id ?? id();

  const prevAssumptions = existing[0]
    ? await db.select().from(thesisAssumptions).where(eq(thesisAssumptions.thesisId, thesisId))
    : [];
  const prevByMetric = new Map(prevAssumptions.map((a) => [a.metric.trim().toLowerCase(), a]));

  const merged = structure.assumptions.map((a, i) => {
    const prev = prevByMetric.get(a.metric.trim().toLowerCase());
    return {
      id: prev?.id ?? id(),
      thesisId,
      metric: a.metric,
      statement: a.statement,
      target: a.target,
      comparator: a.comparator,
      unit: a.unit,
      status: prev?.status ?? "unknown",
      note: prev?.note ?? null,
      sortOrder: i,
      updatedAt: now,
    };
  });

  const values = {
    thesis: renderThesisMarkdown(structure, merged),
    structure: JSON.stringify(structure),
    conviction: input.conviction ?? existing[0]?.conviction ?? null,
    horizon: input.horizon ?? existing[0]?.horizon ?? null,
    targetPrice: input.targetPrice ?? existing[0]?.targetPrice ?? null,
    generatedBy: input.generatedBy,
    updatedAt: now,
  };

  if (existing[0]) {
    await db.update(theses).set(values).where(eq(theses.id, thesisId));
    await db.delete(thesisAssumptions).where(eq(thesisAssumptions.thesisId, thesisId));
  } else {
    await db.insert(theses).values({ id: thesisId, assetId: input.assetId, ...values });
  }
  if (merged.length > 0) await db.insert(thesisAssumptions).values(merged);

  const kept = merged.filter((m) => prevByMetric.has(m.metric.trim().toLowerCase())).length;
  await db.insert(thesisChanges).values({
    id: id(),
    thesisId,
    eventId: null,
    kind: input.generatedBy === "manual" ? "manual" : "generated",
    summary: existing[0]
      ? `Tesis actualizada (${input.generatedBy}): ${merged.length} supuestos, ${kept} conservados.`
      : `Tesis creada (${input.generatedBy}): ${merged.length} supuestos.`,
    payload: JSON.stringify({ promptVersion: input.promptVersion ?? null, assumptions: merged.length }),
    status: "applied",
    createdAt: now,
    resolvedAt: now,
  });

  return thesisId;
}

export async function updateAssumptions(
  thesisId: string,
  updates: Array<{ id: string; status: AssumptionStatus; note?: string | null }>,
): Promise<number> {
  let n = 0;
  for (const u of updates) {
    const res = await db
      .update(thesisAssumptions)
      .set({ status: u.status, note: u.note ?? null, updatedAt: Date.now() })
      .where(and(eq(thesisAssumptions.id, u.id), eq(thesisAssumptions.thesisId, thesisId)))
      .returning({ id: thesisAssumptions.id });
    n += res.length;
  }
  if (n > 0) {
    await db.insert(thesisChanges).values({
      id: id(),
      thesisId,
      kind: "manual",
      summary: `${n} supuesto(s) actualizados a mano.`,
      payload: JSON.stringify({ updates }),
      status: "applied",
      createdAt: Date.now(),
      resolvedAt: Date.now(),
    });
    await rerender(thesisId);
  }
  return n;
}

export async function setConviction(thesisId: string, conviction: number): Promise<void> {
  const c = Math.max(1, Math.min(5, Math.round(conviction)));
  await db.update(theses).set({ conviction: c, updatedAt: Date.now() }).where(eq(theses.id, thesisId));
  await db.insert(thesisChanges).values({
    id: id(),
    thesisId,
    kind: "manual",
    summary: `Conviccion fijada en ${c}/5.`,
    payload: JSON.stringify({ conviction: c }),
    status: "applied",
    createdAt: Date.now(),
    resolvedAt: Date.now(),
  });
}

/** Vuelve a generar el markdown con los estados actuales de los supuestos. */
async function rerender(thesisId: string) {
  const row = (await db.select().from(theses).where(eq(theses.id, thesisId)).limit(1))[0];
  const structure = parseStructure(row?.structure ?? null);
  if (!row || !structure) return;
  const asum = await db
    .select()
    .from(thesisAssumptions)
    .where(eq(thesisAssumptions.thesisId, thesisId))
    .orderBy(thesisAssumptions.sortOrder);
  await db
    .update(theses)
    .set({ thesis: renderThesisMarkdown(structure, asum), updatedAt: Date.now() })
    .where(eq(theses.id, thesisId));
}

// ---------------------------------------------------------------------------
// Lectura

export async function getThesisView(assetId: string): Promise<ThesisView | null> {
  const rows = await db
    .select({ thesis: theses, asset: assets })
    .from(theses)
    .innerJoin(assets, eq(theses.assetId, assets.id))
    .where(eq(theses.assetId, assetId))
    .limit(1);
  if (!rows[0]) return null;
  return (await hydrate([rows[0]]))[0];
}

export async function listTheses(): Promise<ThesisView[]> {
  const rows = await db
    .select({ thesis: theses, asset: assets })
    .from(theses)
    .innerJoin(assets, eq(theses.assetId, assets.id))
    .orderBy(desc(theses.updatedAt));
  return hydrate(rows);
}

async function hydrate(rows: Array<{ thesis: Thesis; asset: Asset }>): Promise<ThesisView[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.thesis.id);
  const [asum, changes] = await Promise.all([
    db
      .select()
      .from(thesisAssumptions)
      .where(inArray(thesisAssumptions.thesisId, ids))
      .orderBy(thesisAssumptions.sortOrder),
    db
      .select()
      .from(thesisChanges)
      .where(inArray(thesisChanges.thesisId, ids))
      .orderBy(desc(thesisChanges.createdAt))
      .limit(30 * rows.length),
  ]);
  const fundamentalsByAsset = new Map<string, FundamentalsView | null>();
  for (const r of rows) fundamentalsByAsset.set(r.asset.id, await getFundamentals(r.asset.id));

  return rows.map((r) => ({
    thesis: r.thesis,
    asset: r.asset,
    structure: parseStructure(r.thesis.structure),
    assumptions: asum.filter((a) => a.thesisId === r.thesis.id),
    pending: changes.filter((c) => c.thesisId === r.thesis.id && c.status === "pending"),
    history: changes.filter((c) => c.thesisId === r.thesis.id && c.status !== "pending").slice(0, 12),
    fundamentals: fundamentalsByAsset.get(r.asset.id) ?? null,
  }));
}

async function recentEventsFor(assetId: string, limit: number): Promise<EventRow[]> {
  return db
    .select()
    .from(events)
    .where(and(eq(events.primaryAssetId, assetId), inArray(events.priority, ["P1", "P2", "P3"])))
    .orderBy(desc(events.occurredAt))
    .limit(limit);
}

// ---------------------------------------------------------------------------
// Propuestas a partir de eventos

export type ProposeDeps = {
  check: (prompt: string) => Promise<{ object: ThesisCheck; model: string }>;
};

const defaultCheck: ProposeDeps["check"] = async (prompt) => {
  const model = await analysisModel();
  const { object } = await generateObject({
    model,
    schema: thesisCheckSchema,
    system: THESIS_CHECK_SYSTEM,
    prompt,
    temperature: 0.1,
    maxRetries: 1,
    abortSignal: AbortSignal.timeout(60_000),
  });
  return { object, model: model.modelId };
};

/** Prompt puro para poder testearlo. */
export function buildCheckPrompt(view: ThesisView, ev: EventRow): string {
  const asum = view.assumptions.map(
    (a) => `- id=${a.id} · ${a.metric}: ${a.statement} [estado actual: ${STATUS_LABELS[a.status as AssumptionStatus] ?? a.status}]`,
  );
  return [
    `Activo: ${view.asset.symbol} (${clean(view.asset.name, 80)}). Conviccion actual: ${view.thesis.conviction ?? "sin fijar"}/5.`,
    `Tesis: ${clean(view.structure?.summary ?? view.thesis.thesis, 1000)}`,
    "Supuestos:",
    ...asum,
    `Rompe-tesis: ${(view.structure?.breakers ?? []).map((b) => clean(b, 300)).join(" | ") || "ninguno definido"}`,
    "",
    `Evento (${ev.priority}, tier ${ev.sourceTier}, impacto en tesis ${ev.thesisImpact}, confianza ${ev.confidence}):`,
    `Titular: «${clean(ev.headline, 200)}»`,
    `Hecho: «${clean(ev.fact, 1500)}»`,
    ev.inference ? `Inferencia: «${clean(ev.inference, 1000)}»` : "",
    ev.assessment ? `Evaluacion: «${clean(ev.assessment, 1000)}»` : "",
    "",
    "Propon los cambios que el evento justifique.",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

/**
 * Aplica la salida del modelo a un payload guardable sin fiarse de ella:
 * solo ids de supuestos que existen, delta acotado, textos limpios.
 */
export function toProposalPayload(check: ThesisCheck, view: ThesisView): ProposalPayload | null {
  const valid = new Set(view.assumptions.map((a) => a.id));
  const updates = check.assumption_updates
    .filter((u) => valid.has(u.id))
    .map((u) => ({ id: u.id, status: u.status, reason: clean(u.reason, 400) }));
  const delta = Math.max(-2, Math.min(2, Math.round(check.conviction_delta)));
  if (!check.material || (updates.length === 0 && !check.breaker_hit && delta === 0)) return null;
  return {
    assumption_updates: updates,
    breaker_hit: check.breaker_hit,
    breaker: check.breaker ? clean(check.breaker, 300) : null,
    conviction_delta: delta,
  };
}

/**
 * Crea una propuesta pendiente para la tesis del activo principal del evento.
 * Devuelve el id de la propuesta o null si no procede (sin tesis, evento
 * debil, ya propuesto, o nada material).
 */
export async function proposeFromEvent(
  eventId: string,
  deps: Partial<ProposeDeps> = {},
): Promise<string | null> {
  const ev = (await db.select().from(events).where(eq(events.id, eventId)).limit(1))[0];
  if (!ev || !ev.primaryAssetId) return null;
  if (ev.sourceTier >= 4 || ev.priority === "P5" || ev.priority === "P4") return null;

  const view = await getThesisView(ev.primaryAssetId);
  if (!view) return null;

  const dup = await db
    .select({ id: thesisChanges.id })
    .from(thesisChanges)
    .where(and(eq(thesisChanges.thesisId, view.thesis.id), eq(thesisChanges.eventId, eventId)))
    .limit(1);
  if (dup[0]) return null;

  const check = deps.check ?? defaultCheck;
  const { object, model } = await check(buildCheckPrompt(view, ev));
  const payload = toProposalPayload(object, view);
  if (!payload) return null;

  const changeId = id();
  await db.insert(thesisChanges).values({
    id: changeId,
    thesisId: view.thesis.id,
    eventId,
    kind: "proposal",
    summary: stripTradeAdvice(clean(object.summary || "Propuesta de cambio", 400)),
    payload: JSON.stringify({
      ...payload,
      eventHeadline: ev.headline,
      model,
      promptVersion: THESIS_PROMPT_VERSION,
    } satisfies ProposalPayload),
    status: "pending",
    createdAt: Date.now(),
  });
  return changeId;
}

export function parsePayload(raw: string): ProposalPayload | null {
  try {
    const p = JSON.parse(raw) as Partial<ProposalPayload>;
    return {
      assumption_updates: Array.isArray(p.assumption_updates) ? p.assumption_updates : [],
      breaker_hit: Boolean(p.breaker_hit),
      breaker: p.breaker ?? null,
      conviction_delta: typeof p.conviction_delta === "number" ? p.conviction_delta : 0,
      eventHeadline: p.eventHeadline,
      model: p.model,
      promptVersion: p.promptVersion,
    };
  } catch {
    return null;
  }
}

/** Acepta (aplica) o rechaza una propuesta pendiente. */
export async function resolveProposal(changeId: string, accept: boolean): Promise<boolean> {
  const change = (await db.select().from(thesisChanges).where(eq(thesisChanges.id, changeId)).limit(1))[0];
  if (!change || change.status !== "pending") return false;
  const now = Date.now();

  if (!accept) {
    await db
      .update(thesisChanges)
      .set({ status: "rejected", resolvedAt: now })
      .where(eq(thesisChanges.id, changeId));
    return true;
  }

  const payload = parsePayload(change.payload);
  if (payload) {
    for (const u of payload.assumption_updates) {
      await db
        .update(thesisAssumptions)
        .set({ status: u.status, note: u.reason, updatedAt: now })
        .where(and(eq(thesisAssumptions.id, u.id), eq(thesisAssumptions.thesisId, change.thesisId)));
    }
    if (payload.conviction_delta !== 0) {
      const row = (await db.select().from(theses).where(eq(theses.id, change.thesisId)).limit(1))[0];
      const current = row?.conviction ?? 3;
      const next = Math.max(1, Math.min(5, current + payload.conviction_delta));
      await db.update(theses).set({ conviction: next, updatedAt: now }).where(eq(theses.id, change.thesisId));
    }
    await rerender(change.thesisId);
  }

  await db
    .update(thesisChanges)
    .set({ status: "accepted", resolvedAt: now })
    .where(eq(thesisChanges.id, changeId));
  return true;
}

/** Propuestas pendientes por evento, para marcarlo en el feed de alertas. */
export async function pendingProposalsByEvent(eventIds: string[]): Promise<Map<string, string>> {
  if (eventIds.length === 0) return new Map();
  const rows = await db
    .select({ eventId: thesisChanges.eventId, id: thesisChanges.id })
    .from(thesisChanges)
    .where(and(inArray(thesisChanges.eventId, eventIds), eq(thesisChanges.status, "pending")));
  const map = new Map<string, string>();
  for (const r of rows) if (r.eventId) map.set(r.eventId, r.id);
  return map;
}
