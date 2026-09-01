/**
 * Reconciliacion de tenencias contra el balance real del exchange/broker.
 *
 * El problema que resuelve: los exchanges (Binance via ccxt) solo nos dan el
 * historial de *trades*, no los depositos ni retiros. Si vendes monedas que
 * depositaste desde fuera, el historial de trades por si solo no reconstruye
 * cuanto tienes: las ventas superan a las compras y el neto se va negativo.
 *
 * El motor de P&L nunca deja el inventario por debajo de 0 (no puedes vender
 * lo que no tienes en el libro), asi que replica los trades "con tope en 0".
 * Por eso el ajuste tiene que calcularse con EXACTAMENTE el mismo modelo: si
 * lo calcularamos con una suma sin tope, el ajuste cuadraria en un modelo y
 * descuadraria en el otro (fue justo el bug que inflaba ETH 43x).
 *
 * Regla: la cantidad que reporta el exchange manda. El ajuste es la diferencia
 * entre esa cantidad real y lo que el replay con tope reconstruye de los trades.
 */

export type HeldTx = {
  type: "buy" | "sell" | "transfer_in" | "transfer_out" | "dividend" | "fee";
  quantity: number;
  executedAt: number;
};

const EPS = 1e-8;

/**
 * Cantidad que queda tras replicar los trades con tope en 0, igual que el motor
 * de P&L. Compras y entradas suman; ventas y salidas restan pero nunca por
 * debajo de 0. Dividendos y comisiones no tocan la cantidad.
 */
export function netHeldQuantity(txs: HeldTx[]): number {
  const ordered = [...txs].sort((a, b) => a.executedAt - b.executedAt);
  let qty = 0;
  for (const t of ordered) {
    const amt = Math.abs(t.quantity);
    if (t.type === "buy" || t.type === "transfer_in") {
      qty += amt;
    } else if (t.type === "sell" || t.type === "transfer_out") {
      qty = Math.max(0, qty - amt);
    }
  }
  return qty;
}

export type Plug = {
  assetId: string;
  direction: "transfer_in" | "transfer_out";
  quantity: number;
};

/**
 * Calcula los ajustes necesarios para que cada activo cuadre con su cantidad
 * real. `targetQty` es lo que reporta el exchange/broker (fuente de verdad).
 * Recorre la union de activos con trades y activos con balance, asi que un
 * activo que ya vendiste del todo (balance 0 pero con trades) se pone a 0 con
 * una salida.
 */
export function buildReconciliation(
  realByAsset: Map<string, HeldTx[]>,
  targetQty: Map<string, number>,
  eps = EPS,
): Plug[] {
  const assetIds = new Set([...realByAsset.keys(), ...targetQty.keys()]);
  const plugs: Plug[] = [];
  for (const assetId of assetIds) {
    const held = netHeldQuantity(realByAsset.get(assetId) ?? []);
    const target = targetQty.get(assetId) ?? 0;
    const diff = target - held;
    if (Math.abs(diff) < eps) continue;
    plugs.push({
      assetId,
      direction: diff > 0 ? "transfer_in" : "transfer_out",
      quantity: Math.abs(diff),
    });
  }
  return plugs;
}
