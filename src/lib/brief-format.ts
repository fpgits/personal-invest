/**
 * Formato de "Que hacer", en un modulo hoja sin dependencias de servidor para
 * que la tarjeta de cliente lo importe sin arrastrar la base de datos.
 */

/** Miles con punto, al estilo espanol, sin depender del ICU del servidor. */
export function money(n: number, currency: string): string {
  const s = String(Math.round(Math.abs(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return currency === "USD" ? `$${s}` : `${s} ${currency}`;
}
