import type { GroupKey } from "./period-metrics";

/**
 * Grupo de activos elegido, global a toda la seccion (como el periodo):
 * Todo / Bolsa / Cripto. Vive en una cookie para las paginas de servidor y en
 * un contexto para las de cliente. "Bolsa" son acciones y ETFs (y el efectivo
 * del broker); "Cripto" son las monedas (y el efectivo del exchange).
 */

export type { GroupKey };

export const GROUP_COOKIE = "invest_group";

export const GROUP_KEYS = ["all", "bolsa", "cripto"] as const;

export const GROUP_LABELS: Record<GroupKey, string> = {
  all: "Todo",
  bolsa: "Bolsa",
  cripto: "Cripto",
};

/** Lo que venga raro cae en "all": el filtro nunca oculta datos por accidente. */
export function parseGroup(raw: string | null | undefined): GroupKey {
  return raw === "bolsa" || raw === "cripto" ? raw : "all";
}

/** Grupo de una clase de activo. Cripto es cripto; el resto (equity, etf) es bolsa. */
export function groupOfClass(assetClass: string): "bolsa" | "cripto" {
  return assetClass === "crypto" ? "cripto" : "bolsa";
}

/** Grupo de una cuenta por su tipo: exchange → cripto, broker (u otro) → bolsa. */
export function accountGroup(accountType: string | null | undefined): "bolsa" | "cripto" {
  return accountType === "exchange" ? "cripto" : "bolsa";
}

/** ¿Esta clase de activo entra en el grupo seleccionado? "all" no filtra. */
export function classInGroup(group: GroupKey, assetClass: string): boolean {
  return group === "all" || groupOfClass(assetClass) === group;
}

/** ¿Esta cuenta (por tipo) entra en el grupo seleccionado? */
export function accountInGroup(group: GroupKey, accountType: string | null | undefined): boolean {
  return group === "all" || accountGroup(accountType) === group;
}
