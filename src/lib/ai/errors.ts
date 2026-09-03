import { APICallError, NoObjectGeneratedError, RetryError } from "ai";
import type { BudgetState } from "./policy";

/**
 * invalid   → el modelo devolvio algo que no cumple el esquema.
 * rejected  → el proveedor rechazo ESTA peticion (4xx: moderacion, prompt
 *             demasiado largo, modelo mal configurado). Reintentar igual no
 *             va a cambiar nada.
 * transient → red, cuota (429), 5xx, timeout. Mas tarde puede funcionar.
 * budget    → presupuesto diario de IA agotado. Manana seguira.
 */
export type FailureKind = "invalid" | "rejected" | "transient" | "budget";

/** Se lanza ANTES de llamar al modelo: no cuesta nada y no es culpa de la peticion. */
export class AiBudgetError extends Error {
  readonly state: BudgetState;
  constructor(state: BudgetState) {
    super(
      `Presupuesto diario de IA agotado (${state.spentUsd.toFixed(2)} de ${state.limitUsd.toFixed(2)} USD). Las tareas de fondo esperan a manana; el chat y lo que pidas a mano siguen funcionando.`,
    );
    this.name = "AiBudgetError";
    this.state = state;
  }
}

export function isBudgetError(e: unknown): e is AiBudgetError {
  return e instanceof AiBudgetError || (e instanceof Error && e.name === "AiBudgetError");
}

/**
 * Decide si merece la pena reintentar. Un 4xx del proveedor no es
 * transitorio: la misma peticion volvera a fallar igual en la siguiente
 * pasada, asi que no puede bloquear el motor.
 */
export function classifyError(e: unknown): FailureKind {
  if (isBudgetError(e)) return "budget";
  if (NoObjectGeneratedError.isInstance(e)) return "invalid";
  const inner = RetryError.isInstance(e) ? e.lastError : e;
  if (APICallError.isInstance(inner)) {
    const status = inner.statusCode ?? 0;
    if (status === 408 || status === 429 || status >= 500 || status === 0) return "transient";
    if (status >= 400) return "rejected";
  }
  return "transient";
}

/** Un timeout es transitorio para el motor, pero cuenta como intento del cluster. */
export function isTimeout(e: unknown): boolean {
  const inner = RetryError.isInstance(e) ? e.lastError : e;
  const name = inner instanceof Error ? inner.name : "";
  return name === "TimeoutError" || name === "AbortError";
}

export function messageOf(e: unknown): string {
  if (RetryError.isInstance(e) && e.lastError instanceof Error) return e.lastError.message;
  return e instanceof Error ? e.message : String(e);
}
