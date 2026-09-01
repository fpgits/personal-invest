/**
 * Colores y etiquetas por clase de activo, compartidos entre paginas de
 * servidor y componentes de cliente. Viven aqui (modulo neutro, sin
 * "use client") porque llamar una funcion exportada por un modulo de
 * cliente desde un Server Component revienta en runtime.
 *
 * Paleta categorica validada contra la superficie oscura #12151a
 * (todos los pares: CVD dE 9.4, vision normal dE 20.9, contraste >= 3:1).
 * El color sigue a la ENTIDAD, no al orden: cripto siempre es el mismo naranja
 * aunque cambie de posicion en la lista.
 */
export const CLASS_COLORS: Record<string, string> = {
  equity: "#3987e5",
  crypto: "#d95926",
  etf: "#199e70",
  cash: "#8b94a3",
};

export const CLASS_LABELS: Record<string, string> = {
  equity: "Bolsa",
  crypto: "Cripto",
  etf: "ETF",
  cash: "Efectivo",
};

export function classColor(assetClass: string) {
  return CLASS_COLORS[assetClass] ?? "#8b94a3";
}
