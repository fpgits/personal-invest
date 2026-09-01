import { XMLParser } from "fast-xml-parser";

/**
 * Interactive Brokers via Flex Web Service.
 *
 * Es la unica via de IBKR que funciona desde un servidor sin estado: la TWS API
 * y la Client Portal API exigen TWS o IB Gateway corriendo en una maquina con
 * sesion viva, cosa imposible en una funcion serverless. Flex es solo un token
 * y dos llamadas HTTPS.
 *
 * Flujo: SendRequest devuelve un codigo de referencia, GetStatement devuelve el
 * XML cuando el informe termina de generarse.
 *
 * Limite: 1 peticion por segundo y 10 por minuto por token.
 */

const BASE =
  process.env.IBKR_FLEX_BASE ??
  "https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService";

// IBKR rechaza peticiones sin User-Agent.
const UA = "personal-invest/1.0";

export type FlexTrade = {
  transactionId: string;
  symbol: string;
  assetCategory: string;
  side: "buy" | "sell";
  quantity: number;
  price: number;
  commission: number;
  currency: string;
  executedAt: number;
};

export type FlexPosition = {
  symbol: string;
  assetCategory: string;
  quantity: number;
  costBasisPrice: number;
  currency: string;
};

export type FlexCash = {
  transactionId: string;
  symbol: string | null;
  type: string;
  amount: number;
  currency: string;
  executedAt: number;
  description: string;
};

/** Saldo en efectivo por divisa (del Cash Report de la Flex Query). */
export type FlexCashBalance = { currency: string; amount: number };

export type FlexStatement = {
  accountId: string;
  fromDate: string | null;
  toDate: string | null;
  trades: FlexTrade[];
  positions: FlexPosition[];
  cash: FlexCash[];
  /** Saldo en efectivo actual por divisa. Vacio si la query no trae Cash Report. */
  cashBalances: FlexCashBalance[];
  /** Filas que no sabemos mapear todavia (opciones, futuros, forex). */
  skipped: Array<{ symbol: string; assetCategory: string; reason: string }>;
};

export class FlexError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "FlexError";
  }
}

/** Mensajes utiles para los codigos de error que devuelve IBKR. */
const ERRORS: Record<string, string> = {
  "1003": "El ID de la query no existe o no pertenece a este token.",
  "1004": "El informe todavia se esta generando. Reintenta en unos segundos.",
  "1005": "La query genero demasiados datos. Acorta el periodo.",
  "1006": "El codigo de referencia no es valido.",
  "1007":
    "La query no tiene datos para ese periodo, o la seccion pedida esta vacia.",
  "1009":
    "El informe se esta generando. Reintenta en unos segundos.",
  "1012":
    "El token de Flex Web Service ha caducado. Genera uno nuevo en Client Portal.",
  "1013":
    "El token tiene restriccion por IP y la IP de Vercel no esta en la lista. Quita la restriccion o usa IP estatica.",
  "1014": "La query no es valida.",
  "1018":
    "Has superado el limite de IBKR (1 peticion por segundo, 10 por minuto).",
  "1019": "El informe tardo demasiado en generarse.",
  "1020": "Token invalido.",
};

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  parseAttributeValue: false,
  trimValues: true,
});

/** Un nodo XML ya parseado: atributos como claves, hijos anidados. */
type XmlNode = Record<string, unknown>;

/**
 * fast-xml-parser devuelve un objeto cuando hay un solo elemento y un array
 * cuando hay varios. Normalizamos siempre a array.
 */
function asArray(v: unknown): XmlNode[] {
  if (v === undefined || v === null) return [];
  return (Array.isArray(v) ? v : [v]) as XmlNode[];
}

/** Lee un atributo como string, sin importar como lo haya tipado el parser. */
function attr(node: XmlNode, ...names: string[]): string {
  for (const n of names) {
    const v = node[n];
    if (v !== undefined && v !== null && v !== "") return String(v);
  }
  return "";
}

function child(node: XmlNode, name: string): XmlNode {
  const v = node[name];
  return v && typeof v === "object" ? (v as XmlNode) : {};
}

function num(v: unknown): number {
  const n = Number(String(v ?? "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
}

/**
 * IBKR usa "20240315", "20240315;103000" y a veces "20240315 10:30:00".
 * Sin hora asumimos mediodia UTC, que evita que la fecha se desplace un dia
 * al renderizarla en cualquier zona horaria razonable.
 */
export function parseFlexDate(raw: unknown): number {
  const s = String(raw ?? "").trim();
  if (!s) return NaN;

  const m = s.match(
    /^(\d{4})(\d{2})(\d{2})(?:[;\s]+(\d{2}):?(\d{2}):?(\d{2}))?/,
  );
  if (m) {
    const [, y, mo, d, h, mi, sec] = m;
    return Date.UTC(
      Number(y),
      Number(mo) - 1,
      Number(d),
      h ? Number(h) : 12,
      mi ? Number(mi) : 0,
      sec ? Number(sec) : 0,
    );
  }

  const parsed = Date.parse(s);
  return Number.isNaN(parsed) ? NaN : parsed;
}

/** IBKR no distingue ETF de accion: ambos son STK. */
export function mapAssetClass(
  category: string,
): "equity" | "etf" | "crypto" | null {
  const c = category.toUpperCase();
  if (c === "STK") return "equity";
  if (c === "FUND" || c === "ETF") return "etf";
  if (c === "CRYPTO") return "crypto";
  return null;
}

function checkForError(parsed: Record<string, unknown>) {
  const resp = parsed.FlexStatementResponse as
    | { Status?: string; ErrorCode?: string | number; ErrorMessage?: string }
    | undefined;

  if (resp && String(resp.Status).toLowerCase() === "fail") {
    const code = String(resp.ErrorCode ?? "");
    throw new FlexError(
      ERRORS[code] ?? resp.ErrorMessage ?? `IBKR devolvio el error ${code}`,
      code,
    );
  }
}

async function flexFetch(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, accept: "application/xml, text/xml, */*" },
    cache: "no-store",
  });
  if (!res.ok) {
    throw new FlexError(`IBKR respondio HTTP ${res.status}`, String(res.status));
  }
  return res.text();
}

export async function sendRequest(
  token: string,
  queryId: string,
): Promise<{ referenceCode: string; url: string }> {
  const url = `${BASE}/SendRequest?t=${encodeURIComponent(token)}&q=${encodeURIComponent(queryId)}&v=3`;
  const xml = await flexFetch(url);
  const parsed = parser.parse(xml) as Record<string, unknown>;
  checkForError(parsed);

  const resp = parsed.FlexStatementResponse as
    | { ReferenceCode?: string | number; Url?: string }
    | undefined;

  const referenceCode = String(resp?.ReferenceCode ?? "");
  if (!referenceCode) {
    throw new FlexError("IBKR no devolvio codigo de referencia");
  }

  // IBKR indica en la respuesta a que URL pedir el informe. La usamos en vez
  // de hardcodearla, por si mueven el endpoint.
  return { referenceCode, url: resp?.Url || `${BASE}/GetStatement` };
}

export async function getStatement(
  token: string,
  referenceCode: string,
  statementUrl: string,
): Promise<string> {
  const url = `${statementUrl}?t=${encodeURIComponent(token)}&q=${encodeURIComponent(referenceCode)}&v=3`;
  return flexFetch(url);
}

/**
 * Pide el informe y espera a que IBKR lo genere. El primer intento suele
 * fallar con 1009 o 1019 porque el informe aun se esta construyendo.
 */
export async function fetchStatement(
  token: string,
  queryId: string,
  { attempts = 6, delayMs = 4000 } = {},
): Promise<FlexStatement> {
  const { referenceCode, url } = await sendRequest(token, queryId);

  let lastError: FlexError | null = null;

  for (let i = 0; i < attempts; i++) {
    // IBKR limita a 1 req/s. Esperamos siempre antes del primer intento.
    await new Promise((r) => setTimeout(r, i === 0 ? 2000 : delayMs));

    const xml = await getStatement(token, referenceCode, url);
    try {
      return parseFlexStatement(xml);
    } catch (e) {
      if (e instanceof FlexError && (e.code === "1009" || e.code === "1019")) {
        lastError = e;
        continue;
      }
      throw e;
    }
  }

  throw lastError ??
    new FlexError("IBKR no termino de generar el informe a tiempo");
}

export function parseFlexStatement(xml: string): FlexStatement {
  const parsed = parser.parse(xml) as Record<string, unknown>;
  checkForError(parsed);

  const response = parsed.FlexQueryResponse as XmlNode | undefined;
  if (!response) {
    throw new FlexError("La respuesta de IBKR no tiene FlexQueryResponse");
  }

  const statement = asArray(child(response, "FlexStatements").FlexStatement)[0];
  if (!statement) {
    throw new FlexError("La respuesta de IBKR no trae ningun FlexStatement");
  }

  const skipped: FlexStatement["skipped"] = [];

  /* ---------- Operaciones ---------- */
  const trades: FlexTrade[] = [];

  for (const t of asArray(child(statement, "Trades").Trade)) {
    const category = attr(t, "assetCategory");
    const symbol = attr(t, "symbol").toUpperCase();

    if (!mapAssetClass(category)) {
      skipped.push({
        symbol: symbol || "?",
        assetCategory: category,
        reason: "tipo de activo no soportado todavia",
      });
      continue;
    }

    const executedAt = parseFlexDate(attr(t, "dateTime", "tradeDate"));
    if (Number.isNaN(executedAt)) {
      skipped.push({
        symbol: symbol || "?",
        assetCategory: category,
        reason: "fecha ilegible",
      });
      continue;
    }

    const rawQuantity = num(t.quantity);
    const quantity = Math.abs(rawQuantity);
    if (quantity === 0) continue;

    trades.push({
      // transactionID es unico y estable entre informes: clave de deduplicacion.
      transactionId:
        attr(t, "transactionID", "tradeID") ||
        `${symbol}-${executedAt}-${quantity}`,
      symbol,
      assetCategory: category,
      side:
        attr(t, "buySell").toUpperCase().startsWith("SELL") || rawQuantity < 0
          ? "sell"
          : "buy",
      quantity,
      price: Math.abs(num(t.tradePrice)),
      // ibCommission viene en negativo porque es un coste.
      commission: Math.abs(num(t.ibCommission ?? t.commission)),
      currency: attr(t, "currency").toUpperCase() || "USD",
      executedAt,
    });
  }

  /* ---------- Posiciones abiertas ---------- */
  const positions: FlexPosition[] = [];

  for (const p of asArray(child(statement, "OpenPositions").OpenPosition)) {
    const category = attr(p, "assetCategory");
    if (!mapAssetClass(category)) continue;

    // Segun la version de la query el campo es "position" o "quantity".
    const quantity = num(p.position ?? p.quantity);
    if (quantity === 0) continue;

    positions.push({
      symbol: attr(p, "symbol").toUpperCase(),
      assetCategory: category,
      quantity,
      costBasisPrice: num(p.costBasisPrice),
      currency: attr(p, "currency").toUpperCase() || "USD",
    });
  }

  /* ---------- Movimientos de efectivo (dividendos, retenciones) ---------- */
  const cash: FlexCash[] = [];

  for (const c of asArray(
    child(statement, "CashTransactions").CashTransaction,
  )) {
    const executedAt = parseFlexDate(
      attr(c, "dateTime", "settleDate", "reportDate"),
    );
    if (Number.isNaN(executedAt)) continue;

    const symbol = attr(c, "symbol").toUpperCase();
    const type = attr(c, "type");
    const amount = num(c.amount);

    cash.push({
      transactionId:
        attr(c, "transactionID") ||
        `${type}-${symbol}-${executedAt}-${amount}`,
      symbol: symbol || null,
      type,
      amount,
      currency: attr(c, "currency").toUpperCase() || "USD",
      executedAt,
      description: attr(c, "description"),
    });
  }

  /* ---------- Saldo en efectivo (Cash Report) ---------- */
  // Solo aparece si la Flex Query tiene activada la seccion "Cash Report".
  // Con "currency breakout" IBKR emite una fila por divisa (mas BASE_SUMMARY,
  // el total en divisa base). SIN breakout emite solo BASE_SUMMARY: en ese caso
  // la usamos como el saldo total en la divisa base, en vez de descartarla.
  const cashRows = asArray(child(statement, "CashReport").CashReportCurrency);
  const baseCurrency =
    attr(child(statement, "AccountInformation"), "currency").toUpperCase() ||
    "USD";
  const perCurrency = cashRows.filter(
    (cr) => attr(cr, "currency").toUpperCase() !== "BASE_SUMMARY",
  );
  const chosen = perCurrency.length > 0 ? perCurrency : cashRows;

  const cashBalances: FlexCashBalance[] = [];
  for (const cr of chosen) {
    const raw = attr(cr, "currency").toUpperCase();
    const currency = !raw || raw === "BASE_SUMMARY" ? baseCurrency : raw;
    const amount = num(cr.endingCash ?? cr.endingSettledCash);
    cashBalances.push({ currency, amount });
  }

  return {
    accountId: attr(statement, "accountId"),
    fromDate: attr(statement, "fromDate") || null,
    toDate: attr(statement, "toDate") || null,
    trades,
    positions,
    cash,
    cashBalances,
    skipped,
  };
}

/** Solo los movimientos que son dividendos cobrados, no retenciones. */
export function isDividend(c: FlexCash): boolean {
  return /dividend/i.test(c.type) && !/tax|withhold/i.test(c.type) && c.amount > 0;
}

export async function testConnection(
  token: string,
  queryId: string,
): Promise<{ ok: boolean; error?: string; accountId?: string; trades?: number }> {
  try {
    const st = await fetchStatement(token, queryId, { attempts: 4 });
    return { ok: true, accountId: st.accountId, trades: st.trades.length };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Error desconocido",
    };
  }
}
