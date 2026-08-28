import Papa from "papaparse";

export type ParsedRow = {
  symbol: string;
  assetClass: "equity" | "etf" | "crypto";
  type: "buy" | "sell" | "dividend" | "fee" | "transfer_in" | "transfer_out";
  quantity: number;
  price: number;
  fee: number;
  currency: string;
  executedAt: number;
  note?: string;
};

export type ParseReport = {
  rows: ParsedRow[];
  errors: Array<{ line: number; message: string; raw?: string }>;
  detectedColumns: Record<string, string>;
};

/**
 * Nombres de columna que aceptamos. Los brokers no se ponen de acuerdo,
 * asi que reconocemos los alias mas habituales en ingles y espanol.
 */
const ALIASES: Record<keyof ParsedRow | "assetClassRaw", string[]> = {
  symbol: ["symbol", "ticker", "simbolo", "activo", "asset", "instrument", "producto", "pair", "par"],
  assetClass: ["class", "asset_class", "clase", "tipo_activo", "category"],
  assetClassRaw: [],
  type: ["type", "side", "action", "tipo", "operacion", "transaction_type", "movimiento"],
  quantity: ["quantity", "qty", "amount", "shares", "cantidad", "unidades", "volumen", "size"],
  price: ["price", "unit_price", "precio", "precio_unitario", "avg_price", "execution_price"],
  fee: ["fee", "fees", "commission", "comision", "comisiones", "costes"],
  currency: ["currency", "moneda", "divisa", "quote_currency"],
  executedAt: ["date", "datetime", "time", "fecha", "executed_at", "trade_date", "timestamp"],
  note: ["note", "notes", "nota", "comment", "descripcion", "description"],
};

function normalize(h: string) {
  return h
    .trim()
    .toLowerCase()
    .replace(/[\s.-]+/g, "_")
    .replace(/[^a-z0-9_]/g, "");
}

function findColumn(headers: string[], field: keyof typeof ALIASES): string | null {
  const norm = headers.map((h) => ({ raw: h, n: normalize(h) }));
  for (const alias of ALIASES[field]) {
    const hit = norm.find((h) => h.n === alias);
    if (hit) return hit.raw;
  }
  for (const alias of ALIASES[field]) {
    const hit = norm.find((h) => h.n.includes(alias));
    if (hit) return hit.raw;
  }
  return null;
}

function parseNumber(v: unknown): number {
  if (typeof v === "number") return v;
  const s = String(v ?? "").trim();
  if (!s) return 0;
  // Acepta "1.234,56" y "1,234.56".
  const cleaned =
    s.lastIndexOf(",") > s.lastIndexOf(".")
      ? s.replace(/\./g, "").replace(",", ".")
      : s.replace(/,/g, "");
  const n = Number(cleaned.replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function parseDate(v: unknown): number {
  const s = String(v ?? "").trim();
  if (!s) return NaN;
  if (/^\d{10}$/.test(s)) return Number(s) * 1000;
  if (/^\d{13}$/.test(s)) return Number(s);
  // dd/mm/yyyy es lo normal en brokers europeos y Date lo lee como mm/dd.
  const euro = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
  if (euro) {
    const [, d, m, y] = euro;
    const ms = Date.parse(`${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}T12:00:00Z`);
    if (!Number.isNaN(ms)) return ms;
  }
  return Date.parse(s);
}

function parseType(v: unknown): ParsedRow["type"] | null {
  const s = String(v ?? "").trim().toLowerCase();
  if (!s) return null;
  if (/^(buy|compra|b|purchase|adquisicion)/.test(s)) return "buy";
  if (/^(sell|venta|s|sale)/.test(s)) return "sell";
  if (/(dividend|dividendo)/.test(s)) return "dividend";
  if (/(deposit|deposito|transfer.?in|entrada|receive)/.test(s)) return "transfer_in";
  if (/(withdraw|retiro|transfer.?out|salida|send)/.test(s)) return "transfer_out";
  if (/(fee|comision|commission)/.test(s)) return "fee";
  return null;
}

function guessClass(symbol: string, explicit: unknown): ParsedRow["assetClass"] {
  const s = String(explicit ?? "").toLowerCase();
  if (s.includes("crypto") || s.includes("cripto")) return "crypto";
  if (s.includes("etf")) return "etf";
  if (s.includes("equity") || s.includes("stock") || s.includes("accion")) return "equity";
  // Los pares tipo BTC/USDT solo aparecen en cripto.
  if (symbol.includes("/") || symbol.includes("-")) return "crypto";
  return "equity";
}

export function parseTransactionsCsv(content: string): ParseReport {
  const parsed = Papa.parse<Record<string, string>>(content, {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: (h) => h.trim(),
  });

  const headers = parsed.meta.fields ?? [];
  const cols = {
    symbol: findColumn(headers, "symbol"),
    assetClass: findColumn(headers, "assetClass"),
    type: findColumn(headers, "type"),
    quantity: findColumn(headers, "quantity"),
    price: findColumn(headers, "price"),
    fee: findColumn(headers, "fee"),
    currency: findColumn(headers, "currency"),
    executedAt: findColumn(headers, "executedAt"),
    note: findColumn(headers, "note"),
  };

  const errors: ParseReport["errors"] = [];
  const rows: ParsedRow[] = [];

  const missing = (["symbol", "type", "quantity", "executedAt"] as const).filter(
    (k) => !cols[k],
  );
  if (missing.length > 0) {
    errors.push({
      line: 0,
      message: `Faltan columnas obligatorias: ${missing.join(", ")}. Cabeceras detectadas: ${headers.join(", ")}`,
    });
    return { rows, errors, detectedColumns: cols as Record<string, string> };
  }

  parsed.data.forEach((raw, i) => {
    const line = i + 2; // +1 por la cabecera, +1 porque los humanos cuentan desde 1
    let symbol = String(raw[cols.symbol!] ?? "").trim().toUpperCase();
    if (!symbol) {
      errors.push({ line, message: "Sin simbolo" });
      return;
    }

    const assetClass = guessClass(
      symbol,
      cols.assetClass ? raw[cols.assetClass] : undefined,
    );
    // BTC/USDT -> BTC
    if (symbol.includes("/")) symbol = symbol.split("/")[0];

    const type = parseType(raw[cols.type!]);
    if (!type) {
      errors.push({
        line,
        message: `Tipo de operacion no reconocido: "${raw[cols.type!]}"`,
      });
      return;
    }

    const quantity = Math.abs(parseNumber(raw[cols.quantity!]));
    if (quantity <= 0 && type !== "fee" && type !== "dividend") {
      errors.push({ line, message: "Cantidad invalida o cero" });
      return;
    }

    const executedAt = parseDate(raw[cols.executedAt!]);
    if (Number.isNaN(executedAt)) {
      errors.push({
        line,
        message: `Fecha no reconocida: "${raw[cols.executedAt!]}"`,
      });
      return;
    }

    rows.push({
      symbol,
      assetClass,
      type,
      quantity: quantity || 1,
      price: cols.price ? Math.abs(parseNumber(raw[cols.price])) : 0,
      fee: cols.fee ? Math.abs(parseNumber(raw[cols.fee])) : 0,
      currency: (cols.currency ? String(raw[cols.currency] ?? "") : "").trim().toUpperCase() || "USD",
      executedAt,
      note: cols.note ? String(raw[cols.note] ?? "").slice(0, 300) : undefined,
    });
  });

  return { rows, errors, detectedColumns: cols as Record<string, string> };
}
