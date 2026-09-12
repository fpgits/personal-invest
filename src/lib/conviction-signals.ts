/**
 * La union: que todo lo que la plataforma sabe termine en UN veredicto.
 *
 * Hasta ahora conviction.ts puntuaba solo con fundamentales y valoracion.
 * Insiders, 13F, eventos y tesis rotas salian en el resumen, en su pestana,
 * cada uno por su lado — y no movian ni un punto del score. O sea: la app
 * recogia cinco cosas y decidia con una.
 *
 * Aqui se juntan, con cuatro reglas que evitan que la union se vuelva papilla:
 *
 *  1. Los fundamentales mandan. Lo demas MODIFICA, no decide: el techo total
 *     son TOTAL_CAP puntos sobre cien. Una compra de directivos no convierte
 *     una empresa mala en buena.
 *  2. Cada fuente tiene su propio tope. Sin esto, tres fuentes correlacionadas
 *     (un evento, la noticia del evento y el filing del evento) sumarian tres
 *     veces lo mismo.
 *  3. Cada modificador trae su linea de por que, con la cifra. Si no se puede
 *     explicar en una frase, no entra.
 *  4. Cuando dos fuentes se contradicen se DICE, no se promedia. Un directivo
 *     comprando mientras un gestor sale es informacion; su media es ruido.
 *
 * Todo puro: recibe datos ya leidos y devuelve numeros y frases.
 */

/** De donde sale cada modificador. */
export type SignalSource = "insiders" | "managers" | "events" | "thesis";

export type Modifier = {
  source: SignalSource;
  label: string;
  /** Puntos con signo, ya acotados por su fuente. */
  points: number;
  /** Una linea con la cifra que lo justifica. */
  detail: string;
};

/**
 * Tope por fuente. Los insiders y los eventos pesan algo mas porque son
 * hechos con fecha y firma; los 13F llegan con hasta 45 dias de retraso y la
 * tesis es criterio propio, asi que pesan menos.
 */
export const SOURCE_CAP: Record<SignalSource, number> = {
  insiders: 6,
  events: 6,
  managers: 4,
  thesis: 5,
};

/** Techo de todo lo que no son fundamentales, en puntos de score. */
export const TOTAL_CAP = 12;

const clampTo = (n: number, cap: number) => Math.max(-cap, Math.min(cap, n));
const round1 = (n: number) => Math.round(n * 10) / 10;

// ---------------------------------------------------------------------------
// Insiders (Form 4)

export type InsiderLite = {
  kind: "cluster_buy" | "big_buy" | "buy" | "big_sell" | "half_position_sell";
  totalValue: number;
  owners: string[];
  occurredAt: number;
};

/** Puntos por tipo de senal, antes de acotar. */
const INSIDER_POINTS: Record<InsiderLite["kind"], number> = {
  cluster_buy: 6,
  big_buy: 4,
  buy: 1.5,
  big_sell: -3,
  half_position_sell: -5,
};

/**
 * Compras y ventas de directivos con su propio dinero. La compra agrupada de
 * varios pesa mas que la de uno: coordinarse para equivocarse es mas dificil.
 *
 * Las ventas pesan MENOS que las compras a igualdad de tamano, y es a
 * proposito: un directivo vende por mil motivos (impuestos, una casa,
 * diversificar) y compra por uno solo.
 */
export function insiderModifier(signals: InsiderLite[]): Modifier | null {
  if (signals.length === 0) return null;
  let raw = 0;
  for (const s of signals) raw += INSIDER_POINTS[s.kind] ?? 0;
  const points = round1(clampTo(raw, SOURCE_CAP.insiders));
  if (points === 0) return null;

  const buys = signals.filter((s) => INSIDER_POINTS[s.kind] > 0);
  const sells = signals.filter((s) => INSIDER_POINTS[s.kind] < 0);
  const people = new Set(signals.flatMap((s) => s.owners)).size;
  const money = (n: number) => `$${Math.round(n).toLocaleString("es-ES")}`;

  let detail: string;
  if (buys.length > 0 && sells.length > 0) {
    detail = `${buys.length} compra(s) y ${sells.length} venta(s) de directivos en los ultimos 30 dias: no van a una`;
  } else if (buys.length > 0) {
    const total = buys.reduce((s, b) => s + b.totalValue, 0);
    detail = `${people} directivo(s) compraron ${money(total)} con su dinero en los ultimos 30 dias`;
  } else {
    const total = sells.reduce((s, b) => s + Math.abs(b.totalValue), 0);
    detail = `${people} directivo(s) vendieron ${money(total)} en los ultimos 30 dias`;
  }
  return { source: "insiders", label: "Directivos", points, detail };
}

// ---------------------------------------------------------------------------
// 13F de gestores seguidos

export type ManagerLite = {
  kind: "new" | "exit" | "increase" | "decrease";
  manager: string;
  /** Peso de la posicion en la cartera del gestor, en %. */
  pct: number;
  deltaPct: number | null;
};

/**
 * Que hicieron los gestores que sigues. Pesa poco a proposito: un 13F es una
 * foto de cierre de trimestre que llega con hasta 45 dias de retraso, no
 * dice el motivo y no incluye cortos. Es una pista, no un dato.
 *
 * Una entrada nueva con peso grande dice mas que un ajuste del 3%.
 */
export function managerModifier(changes: ManagerLite[]): Modifier | null {
  if (changes.length === 0) return null;
  let raw = 0;
  for (const c of changes) {
    // El peso en SU cartera modula: una posicion del 8% es una conviccion,
    // una del 0,3% es una prueba.
    const weight = Math.min(1, Math.max(0.2, c.pct / 5));
    if (c.kind === "new") raw += 3 * weight;
    else if (c.kind === "exit") raw -= 3 * weight;
    else if (c.kind === "increase") raw += 1.5 * weight * (c.deltaPct && c.deltaPct > 50 ? 1.5 : 1);
    else raw -= 1.5 * weight * (c.deltaPct && c.deltaPct < -50 ? 1.5 : 1);
  }
  const points = round1(clampTo(raw, SOURCE_CAP.managers));
  if (points === 0) return null;

  const entradas = changes.filter((c) => c.kind === "new" || c.kind === "increase");
  const salidas = changes.filter((c) => c.kind === "exit" || c.kind === "decrease");
  const names = [...new Set(changes.map((c) => c.manager))].slice(0, 2).join(", ");
  const detail =
    entradas.length > 0 && salidas.length > 0
      ? `Los gestores que sigues no van a una: ${entradas.length} entrando y ${salidas.length} saliendo (${names})`
      : entradas.length > 0
        ? `${names} ${entradas.length === 1 && entradas[0].kind === "new" ? "abrio posicion" : "aumento"} en su ultimo 13F`
        : `${names} ${salidas.length === 1 && salidas[0].kind === "exit" ? "salio del todo" : "recorto"} en su ultimo 13F`;
  return { source: "managers", label: "Gestores (13F)", points, detail };
}

// ---------------------------------------------------------------------------
// Eventos del motor de inteligencia

export type EventLite = {
  /** P1..P5; solo P1-P3 pesan. */
  priority: string;
  /** -100..100, el signo lo da el motor. */
  thesisImpact: number;
  headline: string;
  occurredAt: number;
};

/** Peso por prioridad: un P1 pesa el triple que un P3. */
const PRIORITY_WEIGHT: Record<string, number> = { P1: 3, P2: 2, P3: 1 };

/**
 * Hechos con impacto sobre la tesis en los ultimos 30 dias. Solo P1-P3: los
 * P4-P5 son ruido por definicion y ya se filtran antes de gastar un token.
 */
export function eventModifier(events: EventLite[]): Modifier | null {
  const useful = events.filter((e) => PRIORITY_WEIGHT[e.priority] !== undefined && Math.abs(e.thesisImpact) >= 20);
  if (useful.length === 0) return null;
  let raw = 0;
  for (const e of useful) raw += (e.thesisImpact / 100) * 2 * PRIORITY_WEIGHT[e.priority];
  const points = round1(clampTo(raw, SOURCE_CAP.events));
  if (points === 0) return null;

  const buenos = useful.filter((e) => e.thesisImpact > 0).length;
  const malos = useful.length - buenos;
  const peor = [...useful].sort((a, b) => Math.abs(b.thesisImpact) - Math.abs(a.thesisImpact))[0];
  const detail =
    buenos > 0 && malos > 0
      ? `${useful.length} hechos relevantes en 30 dias y se contradicen (${buenos} a favor, ${malos} en contra). El mayor: ${peor.headline}`
      : `${useful.length} hecho(s) relevante(s) en 30 dias, todos ${buenos > 0 ? "a favor" : "en contra"}. El mayor: ${peor.headline}`;
  return { source: "events", label: "Hechos recientes", points, detail };
}

// ---------------------------------------------------------------------------
// Estado de la tesis

export type AssumptionLite = { statement: string; status: string };

/**
 * Tus propios supuestos, medidos. Un supuesto roto es la senal mas fuerte que
 * existe para ti, porque lo escribiste tu: si la razon por la que compraste ya
 * no se cumple, da igual lo barata que este.
 */
export function thesisModifier(assumptions: AssumptionLite[]): Modifier | null {
  const known = assumptions.filter((a) => a.status !== "unknown");
  if (known.length === 0) return null;
  const roto = known.filter((a) => a.status === "broken");
  const riesgo = known.filter((a) => a.status === "at_risk");
  const bien = known.filter((a) => a.status === "on_track");

  const raw = roto.length * -3 + riesgo.length * -1.5 + bien.length * 0.75;
  const points = round1(clampTo(raw, SOURCE_CAP.thesis));
  if (points === 0) return null;

  const detail =
    roto.length > 0
      ? `${roto.length} supuesto(s) de tu tesis ROTO(S): "${roto[0].statement}"`
      : riesgo.length > 0
        ? `${riesgo.length} supuesto(s) en riesgo: "${riesgo[0].statement}"`
        : `${bien.length} de ${known.length} supuestos cumpliendose`;
  return { source: "thesis", label: "Tu tesis", points, detail };
}

// ---------------------------------------------------------------------------
// Composicion

export type SignalInput = {
  insiders?: InsiderLite[];
  managers?: ManagerLite[];
  events?: EventLite[];
  assumptions?: AssumptionLite[];
};

export type SignalVerdict = {
  modifiers: Modifier[];
  /** Suma ya acotada por TOTAL_CAP. */
  total: number;
  /** Frases para el veredicto: por que se movio el score. */
  lines: string[];
  /** Fuentes que apuntan en direcciones opuestas, si las hay. */
  conflict: boolean;
};

/**
 * Junta las cuatro fuentes. El total se acota otra vez: cuatro fuentes al
 * maximo sumarian 21 puntos y eso ya no seria un modificador, seria un
 * segundo motor. Puro.
 */
export function collectModifiers(input: SignalInput): SignalVerdict {
  const modifiers = [
    insiderModifier(input.insiders ?? []),
    managerModifier(input.managers ?? []),
    eventModifier(input.events ?? []),
    thesisModifier(input.assumptions ?? []),
  ].filter((m): m is Modifier => m !== null);

  const sum = modifiers.reduce((s, m) => s + m.points, 0);
  const total = round1(clampTo(sum, TOTAL_CAP));
  const positive = modifiers.some((m) => m.points > 0);
  const negative = modifiers.some((m) => m.points < 0);

  return {
    modifiers: [...modifiers].sort((a, b) => Math.abs(b.points) - Math.abs(a.points)),
    total,
    lines: modifiers.map((m) => `${m.points > 0 ? "+" : ""}${m.points} ${m.label.toLowerCase()}: ${m.detail}`),
    conflict: positive && negative,
  };
}

/** El score con la union aplicada, acotado a 0..100. Puro. */
export function scoreWithSignals(base: number, total: number): number {
  return Math.max(0, Math.min(100, Math.round(base + total)));
}
