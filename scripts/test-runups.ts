/**
 * Tests del detector de grandes subidas y máximos históricos (puro, sin red).
 * Series sintéticas con la forma de los casos reales: GoPro (+183% en cinco
 * días tras años de caída), NVDA 2023 (subida larga que rompe el ATH), y las
 * trampas: una serie plana, una subida que no llega al umbral, un rally con
 * máximos nuevos cada día que NO debe contar como muchos ATH.
 * Correr con: npm run test:runups
 */
import { findAths, findEpisodes, findRunups, shiftDate } from "../src/lib/runups";
import type { DailyClose } from "../src/lib/market/stooq";

let failures = 0;
let checks = 0;
function truthy(v: unknown, label: string) {
  checks++;
  if (!v) {
    failures++;
    console.error(`  FALLO ${label}`);
  } else {
    console.log(`  ok  ${label}`);
  }
}
function eq<T>(actual: T, expected: T, label: string) {
  checks++;
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures++;
    console.error(`  FALLO ${label}: esperado ${JSON.stringify(expected)}, obtenido ${JSON.stringify(actual)}`);
  } else {
    console.log(`  ok  ${label}`);
  }
}

/** Serie diaria desde una fecha con una lista de cierres. */
function series(start: string, closes: number[]): DailyClose[] {
  return closes.map((close, i) => ({ date: shiftDate(start, i), close }));
}
function flat(n: number, v: number): number[] {
  return Array.from({ length: n }, () => v);
}
function ramp(n: number, from: number, to: number): number[] {
  return Array.from({ length: n }, (_, i) => from + ((to - from) * i) / Math.max(1, n - 1));
}

console.log("\n# GoPro: años de caída, cinco días de +180%");
{
  // 400 días bajando de 2,0 a 0,65, meseta, y el salto de septiembre.
  const closes = [...ramp(400, 2.0, 0.65), ...flat(60, 0.66), 0.9, 1.25, 1.69, 1.45, 1.75, 1.42, 1.4];
  const s = series("2025-06-01", closes);
  const eps = findRunups(s);
  eq(eps.length, 1, "un solo episodio");
  const e = eps[0];
  eq(e.kind, "runup", "es una subida");
  truthy(e.gainPct > 160 && e.gainPct < 175, `ganancia ~+169% (${e.gainPct}%)`);
  // El mínimo real fue dos meses antes del salto (la meseta cuenta): el
  // escenario existía todo ese tiempo, que es justo lo que queremos estudiar.
  truthy(e.days <= 70, `de mínimo a pico en unos dos meses (${e.days} días)`);
  eq(e.peakPrice, 1.75, "el pico es el mejor cierre, no el primero que cruza el umbral");
  eq(e.lookbackDate, shiftDate(e.troughDate, -182), "la fecha de mirada atrás es seis meses antes del mínimo");
  truthy(e.troughPrice <= 0.66, `arranca en el mínimo real (${e.troughPrice})`);
}

console.log("\n# NVDA 2023: subida larga que rompe un techo de más de un año");
{
  // Techo en 330 (día 0), caída a 110 durante un año, y subida de nueve meses hasta 500.
  const closes = [330, ...ramp(365, 320, 110), ...ramp(270, 112, 500)];
  const s = series("2021-11-01", closes);
  const ups = findRunups(s);
  truthy(ups.length >= 1, `detecta la subida (${ups.length})`);
  truthy(ups[0].gainPct > 300, `+300% o más (${ups[0].gainPct}%)`);
  const aths = findAths(s);
  eq(aths.length, 1, "UN solo máximo histórico: la ruptura del techo de 330, no cada día del rally");
  truthy(aths[0].peakPrice > 330 && aths[0].peakPrice < 340, `la ruptura ocurre justo al pasar 330 (${aths[0].peakPrice})`);
  eq(aths[0].lookbackDate, shiftDate(aths[0].anchorDate, -182), "seis meses antes de la ruptura");
  truthy(aths[0].troughPrice <= 111, "arrastra el mínimo del ciclo bajista como origen");
}

console.log("\n# lo que NO es un episodio");
{
  eq(findEpisodes(series("2024-01-01", flat(500, 100))), [], "una serie plana no tiene nada");
  eq(findRunups(series("2024-01-01", ramp(300, 100, 160))), [], "un +60% no llega al umbral del 80%");
  // +90% pero en dos años: fuera de la ventana de 365 días.
  eq(findRunups(series("2022-01-01", ramp(730, 100, 190))), [], "una subida lenta de dos años no cuenta");
  // Máximos nuevos todos los días: ninguno rompe un techo de hace un año.
  eq(findAths(series("2024-01-01", ramp(400, 100, 200))), [], "un rally sin techo previo no es 'romper un máximo'");
  eq(findRunups([]), [], "vacío");
  eq(findRunups([{ date: "2024-01-01", close: 1 }]), [], "un solo punto");
}

console.log("\n# un movimiento no se cuenta dos veces, y dos sí");
{
  // Dos subidas separadas por una caída fuerte.
  const closes = [...flat(30, 10), ...ramp(30, 10, 20), ...ramp(60, 20, 8), ...flat(30, 8), ...ramp(30, 8, 18), ...flat(20, 17)];
  const eps = findRunups(series("2024-01-01", closes));
  eq(eps.length, 2, `dos episodios (${eps.map((e) => `${e.troughDate}→${e.peakDate} +${e.gainPct}%`).join(", ")})`);
  truthy(eps[0].peakDate < eps[1].troughDate, "el segundo empieza después de que acabe el primero");
}

console.log("\n# datos sucios");
{
  const s = [
    { date: "2024-01-03", close: 10 },
    { date: "2024-01-01", close: 10 },
    { date: "2024-01-02", close: -5 },
    { date: "basura", close: 100 },
    { date: "2024-01-01", close: 10 }, // repetido
    ...series("2024-01-04", ramp(20, 10, 20)),
  ];
  const eps = findRunups(s);
  eq(eps.length, 1, "ordena, quita fechas malas, negativos y repetidos, y aun así detecta");
  eq(eps[0].troughPrice, 10, "y arranca en el mínimo real de la serie limpia");
  truthy(eps[0].troughDate >= "2024-01-01" && eps[0].troughDate <= "2024-01-04", `en el último toque del mínimo (${eps[0].troughDate})`);
}

console.log("\n# shiftDate");
{
  eq(shiftDate("2026-09-03", -182), "2026-03-05", "seis meses atrás");
  eq(shiftDate("2024-02-28", 2), "2024-03-01", "bisiesto");
}

console.log(`\n${checks} comprobaciones, ${failures} fallos`);
process.exit(failures > 0 ? 1 : 0);
