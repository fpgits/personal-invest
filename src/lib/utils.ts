import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function id(): string {
  return crypto.randomUUID();
}

export function fmtMoney(value: number, currency = "USD", compact = false) {
  return new Intl.NumberFormat("es-ES", {
    style: "currency",
    currency,
    notation: compact ? "compact" : "standard",
    maximumFractionDigits: Math.abs(value) < 1 && value !== 0 ? 6 : 2,
  }).format(value);
}

export function fmtPct(value: number, digits = 2) {
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(digits)}%`;
}

export function fmtQty(value: number) {
  return new Intl.NumberFormat("es-ES", {
    maximumFractionDigits: value < 1 ? 8 : 4,
  }).format(value);
}

export function fmtDate(ms: number) {
  return new Intl.DateTimeFormat("es-ES", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(new Date(ms));
}

export function fmtDateTime(ms: number) {
  return new Intl.DateTimeFormat("es-ES", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(ms));
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Corre promesas en tandas para no pasarse de rate limit. */
export async function batched<T, R>(
  items: T[],
  size: number,
  fn: (item: T) => Promise<R>,
  delayMs = 0,
): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    const chunk = items.slice(i, i + size);
    out.push(...(await Promise.all(chunk.map(fn))));
    if (delayMs && i + size < items.length) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  return out;
}
