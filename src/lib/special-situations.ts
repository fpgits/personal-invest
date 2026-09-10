import { describeSignals, isAsymmetricSetup, type FilingSignal } from "./special-signals";

/**
 * Situaciones especiales: "opcionalidad barata". Un carril APARTE del oráculo,
 * a propósito. El oráculo busca buenos negocios a buen precio; esto busca
 * otra cosa: empresas que el mercado valora como si fueran a morir pero que
 * tienen algo que vale más que su capitalización para alguien (marca,
 * patentes, cotización, cliente) y una razón para que ese alguien aparezca
 * pronto. GoPro en agosto de 2026: $125M de capitalización con $400M de
 * ventas, going concern, y un 10-Q diciendo que buscaba comprador.
 *
 * Reglas de la casa:
 *  - Nunca sale como "comprar". Sale como APUESTA: puedes perderlo todo y la
 *    tasa de acierto real no se conoce todavía (se medirá en el marcador).
 *  - Se juega en cesta, con un tope pequeño por idea. Una o dos pagan por las
 *    que se van a cero; una sola apuesta grande es una lotería.
 *  - El escenario es apuro Y catalizador. Apuro solo es una empresa en
 *    problemas; catalizador sin apuro es una fusión normal.
 *
 * Determinista y sin IA. Los pesos son criterio, no ley: están aquí, en un
 * sitio, para poder cambiarlos y para poder medirlos.
 */

export type SpecialInput = {
  symbol: string;
  marketCap: number | null;
  /** Ingresos anuales más recientes conocidos. */
  revenue: number | null;
  cash: number | null;
  debt: number | null;
  /** Caída desde el máximo de 5 años, ≤ 0. */
  drawdownPct: number | null;
  /** Señales del texto de los últimos filings. */
  signals: FilingSignal[];
  /** Un 13D/13G presentado en los últimos 90 días. */
  recentStake: boolean;
  /** Compras de insiders en los últimos 30 días. */
  insiderBuys: number;
};

export type SpecialComponent = { key: string; label: string; weight: number; value: number; detail: string };

export type SpecialTier = "apuesta" | "vigilar" | "nada";

export type SpecialResult = {
  symbol: string;
  score: number;
  tier: SpecialTier;
  components: SpecialComponent[];
  /** Una frase con los números que mandan. */
  reason: string;
  /** Lo que tiene que pasar para que la apuesta falle del todo. */
  risk: string;
  asymmetric: boolean;
};

export const SPECIAL_WEIGHTS = {
  cheap: 25,
  small: 10,
  crushed: 15,
  distress: 15,
  catalyst: 25,
  ownership: 10,
} as const;

export const SPECIAL_BANDS: Array<[number, SpecialTier]> = [
  [70, "apuesta"],
  [50, "vigilar"],
  [0, "nada"],
];

/** Interpolación lineal acotada entre dos puntos (x0→y0, x1→y1). */
function lerp(x: number, x0: number, y0: number, x1: number, y1: number): number {
  if (x0 === x1) return y0;
  const t = Math.max(0, Math.min(1, (x - x0) / (x1 - x0)));
  return y0 + (y1 - y0) * t;
}

function money(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `$${Math.round(n / 1e6)}M`;
  return `$${Math.round(n)}`;
}

/** Puntúa el escenario. Puro. */
export function evaluateSpecial(input: SpecialInput): SpecialResult {
  const parts: SpecialComponent[] = [];
  const { marketCap, revenue, cash, debt, drawdownPct, signals } = input;

  // 1. Barata frente a lo que vende: EV/ventas. Sin ingresos no hay "barata".
  const netDebt = (debt ?? 0) - (cash ?? 0);
  const ev = marketCap !== null ? marketCap + netDebt : null;
  const evs = ev !== null && revenue && revenue > 0 ? ev / revenue : null;
  parts.push({
    key: "cheap",
    label: "Barata frente a ventas",
    weight: SPECIAL_WEIGHTS.cheap,
    value: evs === null ? 0 : lerp(evs, 0.3, 1, 1.0, 0),
    detail: evs === null ? "sin ingresos o sin capitalización" : `EV/ventas ${evs.toFixed(2)}`,
  });

  // 2. Pequeña: los movimientos asimétricos necesitan poca capitalización.
  parts.push({
    key: "small",
    label: "Capitalización pequeña",
    weight: SPECIAL_WEIGHTS.small,
    value: marketCap === null ? 0 : lerp(marketCap, 300e6, 1, 2e9, 0),
    detail: marketCap === null ? "n/d" : `${money(marketCap)} de capitalización`,
  });

  // 3. Machacada: pesimismo máximo ya en el precio.
  parts.push({
    key: "crushed",
    label: "Pesimismo máximo",
    weight: SPECIAL_WEIGHTS.crushed,
    value: drawdownPct === null ? 0 : lerp(drawdownPct, -80, 1, -40, 0),
    detail: drawdownPct === null ? "n/d" : `${Math.round(drawdownPct)}% desde el máximo de 5 años`,
  });

  // 4. Apuro pero no muerte: la señal de apuro está, y hay caja para aguantar
  //    a que llegue el catalizador.
  const distress = signals.filter((s) => s.polarity === "distress");
  const alive = cash !== null && cash > 0;
  parts.push({
    key: "distress",
    label: "Apuro, pero con caja",
    weight: SPECIAL_WEIGHTS.distress,
    value: distress.length > 0 ? (alive ? 1 : 0.4) : 0.3,
    detail:
      distress.length > 0
        ? `${distress.map((s) => s.label.toLowerCase()).join(", ")}${cash !== null ? ` · caja ${money(cash)}` : ""}`
        : "sin señales de apuro en los filings",
  });

  // 5. Catalizador: la empresa busca comprador, o alguien ya llegó.
  const has = (k: string) => signals.some((s) => s.key === k);
  let catalyst = 0;
  let catalystDetail = "ninguno en los filings";
  if (has("sale_or_merger") || has("strategic_alternatives")) {
    catalyst = 1;
    catalystDetail = "la empresa busca venta, fusión o alternativas";
  } else if (has("definitive_agreement")) {
    catalyst = 0.8;
    catalystDetail = "acuerdo ya firmado: el salto puede haber pasado ya";
  } else if (has("advisors_engaged")) {
    catalyst = 0.7;
    catalystDetail = "ha contratado asesores";
  } else if (has("large_stake") || input.recentStake) {
    catalyst = 0.6;
    catalystDetail = "alguien ha declarado una participación grande";
  }
  parts.push({ key: "catalyst", label: "Catalizador a la vista", weight: SPECIAL_WEIGHTS.catalyst, value: catalyst, detail: catalystDetail });

  // 6. Dinero entrando: 13D/13G reciente o insiders comprando.
  const own = input.recentStake ? 1 : input.insiderBuys >= 2 ? 0.8 : input.insiderBuys === 1 ? 0.5 : 0;
  parts.push({
    key: "ownership",
    label: "Dinero entrando",
    weight: SPECIAL_WEIGHTS.ownership,
    value: own,
    detail: input.recentStake
      ? "participación nueva declarada (13D/13G) en 90 días"
      : input.insiderBuys > 0
        ? `${input.insiderBuys} compra${input.insiderBuys > 1 ? "s" : ""} de insiders en 30 días`
        : "sin compras recientes",
  });

  const score = Math.round(parts.reduce((s, p) => s + p.weight * p.value, 0));
  const asymmetric = isAsymmetricSetup(signals);
  let tier: SpecialTier = "nada";
  for (const [min, t] of SPECIAL_BANDS) {
    if (score >= min) {
      tier = t;
      break;
    }
  }
  // Sin catalizador no hay apuesta, por barata que esté: es solo una empresa barata en problemas.
  if (tier === "apuesta" && catalyst === 0) tier = "vigilar";

  const bits: string[] = [];
  if (evs !== null) bits.push(`EV/ventas ${evs.toFixed(2)}`);
  if (marketCap !== null) bits.push(`${money(marketCap)} de capitalización`);
  if (drawdownPct !== null) bits.push(`${Math.round(drawdownPct)}% desde máximos`);
  const sig = describeSignals(signals);
  const reason = `${bits.join(", ")}${sig ? ` · ${sig}` : ""}`;
  const risk =
    distress.length > 0
      ? "Puede irse a cero: hay duda sobre su continuidad. Si el catalizador no llega antes de que se acabe la caja, se pierde todo."
      : "Sin catalizador confirmado, puede quedarse barata años.";

  return { symbol: input.symbol, score, tier, components: parts, reason, risk, asymmetric };
}

/**
 * Tamaño de una apuesta: pequeño y fijo, como cesta. Nunca proporcional a la
 * "convicción": aquí la convicción es que las probabilidades están a favor,
 * no que esta idea en concreto vaya a salir. Puro.
 */
export const SPECIAL_MAX_PCT_PER_IDEA = 2;
export const SPECIAL_MAX_PCT_BASKET = 8;

export function basketTicket(portfolioValue: number, openBets: number, roundTo = 10): number {
  if (portfolioValue <= 0) return 0;
  const perIdea = (portfolioValue * SPECIAL_MAX_PCT_PER_IDEA) / 100;
  const basketLeft = Math.max(0, (portfolioValue * SPECIAL_MAX_PCT_BASKET) / 100 - openBets);
  return Math.floor(Math.min(perIdea, basketLeft) / roundTo) * roundTo;
}
