/**
 * Señales de "situación especial" en el texto de los filings (10-Q, 10-K,
 * 8-K). Determinista: expresiones sobre el texto, con la cita para que el
 * humano vea de dónde sale. Sin IA.
 *
 * La lección de GoPro: el 10-Q de agosto decía, literalmente, que la empresa
 * había "contratado asesores para evaluar una posible venta o fusión" y que
 * había "duda sustancial sobre su capacidad de continuar". Un mes después
 * llegó la fusión y la acción hizo +183%. No era predecible el día; sí era
 * legible el escenario, y estaba en un documento público.
 *
 * Dos polaridades y las dos importan: `distress` (apuro: going concern,
 * covenants, aviso de exclusión) y `catalyst` (algo puede pasar: busca
 * comprador, asesores contratados, acuerdo firmado). El escenario asimétrico
 * es apuro + catalizador a la vez; apuro solo es apuro.
 */

export type SignalKey =
  | "going_concern"
  | "covenant_breach"
  | "delisting_risk"
  | "reverse_split"
  | "strategic_alternatives"
  | "sale_or_merger"
  | "advisors_engaged"
  | "definitive_agreement"
  | "large_stake";

export type FilingSignal = {
  key: SignalKey;
  label: string;
  polarity: "distress" | "catalyst";
  /** Fragmento alrededor de la coincidencia, sin jerga añadida. */
  quote: string;
};

type Rule = { key: SignalKey; label: string; polarity: FilingSignal["polarity"]; patterns: RegExp[] };

/** Orden = orden de aparición en la salida. Editable: es criterio, no ley. */
export const SIGNAL_RULES: Rule[] = [
  {
    key: "going_concern",
    label: "Duda sobre su continuidad (going concern)",
    polarity: "distress",
    patterns: [/substantial doubt[^.]{0,120}going concern/i, /going concern/i],
  },
  {
    key: "covenant_breach",
    label: "Incumple covenants de deuda",
    polarity: "distress",
    patterns: [
      /not in compliance with[^.]{0,120}covenant/i,
      /covenant (breach|violation|default)/i,
      /(breach|violation) of[^.]{0,60}covenant/i,
      /waiver[^.]{0,120}covenant/i,
    ],
  },
  {
    key: "delisting_risk",
    label: "Riesgo de exclusión de bolsa",
    polarity: "distress",
    patterns: [/minimum bid price/i, /(nasdaq|nyse)[^.]{0,120}(deficiency|delist)/i, /delisting/i],
  },
  {
    key: "reverse_split",
    label: "Contrasplit",
    polarity: "distress",
    patterns: [/reverse (stock )?split/i],
  },
  {
    key: "strategic_alternatives",
    label: "Revisa alternativas estratégicas",
    polarity: "catalyst",
    patterns: [/strategic alternatives/i, /review of strategic options/i, /strategic review/i],
  },
  {
    key: "sale_or_merger",
    label: "Busca venta o fusión",
    polarity: "catalyst",
    patterns: [
      /potential (sale|merger|business combination)/i,
      /(sale|merger) of the company/i,
      /(evaluate|explore|pursue)[^.]{0,80}(sale|merger|combination)/i,
    ],
  },
  {
    key: "advisors_engaged",
    label: "Ha contratado asesores",
    polarity: "catalyst",
    patterns: [/(engaged|retained|hired)[^.]{0,80}advis(o|e)rs?/i],
  },
  {
    key: "definitive_agreement",
    label: "Acuerdo definitivo firmado",
    polarity: "catalyst",
    patterns: [/definitive (merger |purchase |)agreement/i, /agreement and plan of merger/i],
  },
  {
    key: "large_stake",
    label: "Alguien declara una participación grande",
    polarity: "catalyst",
    patterns: [/beneficially own[^.]{0,60}\b([5-9]|[1-9]\d)(\.\d+)?\s?%/i, /acquired[^.]{0,80}\b([5-9]|[1-9]\d)(\.\d+)?\s?% of/i],
  },
];

const QUOTE_CHARS = 140;

function quoteAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - QUOTE_CHARS / 2);
  const end = Math.min(text.length, index + length + QUOTE_CHARS / 2);
  const raw = text.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${raw}${end < text.length ? "…" : ""}`;
}

/** Recorre el texto y devuelve una señal por clave (la primera cita). Puro. */
export function scanFilingText(text: string): FilingSignal[] {
  if (!text) return [];
  const out: FilingSignal[] = [];
  for (const rule of SIGNAL_RULES) {
    for (const re of rule.patterns) {
      const m = re.exec(text);
      if (!m) continue;
      out.push({ key: rule.key, label: rule.label, polarity: rule.polarity, quote: quoteAround(text, m.index, m[0].length) });
      break;
    }
  }
  return out;
}

/** El escenario asimétrico: apuro Y catalizador a la vez. Puro. */
export function isAsymmetricSetup(signals: FilingSignal[]): boolean {
  const distress = signals.some((s) => s.polarity === "distress");
  const catalyst = signals.some((s) => s.polarity === "catalyst");
  return distress && catalyst;
}

/** Resumen en una línea para el humano. Puro. */
export function describeSignals(signals: FilingSignal[]): string {
  if (signals.length === 0) return "";
  const d = signals.filter((s) => s.polarity === "distress").map((s) => s.label.toLowerCase());
  const c = signals.filter((s) => s.polarity === "catalyst").map((s) => s.label.toLowerCase());
  const parts: string[] = [];
  if (d.length) parts.push(`apuro: ${d.join(", ")}`);
  if (c.length) parts.push(`catalizador: ${c.join(", ")}`);
  return parts.join(" · ");
}
