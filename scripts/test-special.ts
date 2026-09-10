/**
 * Tests de la puntuación de situaciones especiales (puro, sin red).
 * El caso 1 es GoPro en agosto de 2026 con sus números reales: $125M de
 * capitalización, $400M de ventas anualizadas, caja $27M, deuda $87M, -96%
 * en cinco años, going concern y "busca comprador" en el 10-Q.
 * Correr con: npm run test:special
 */
import { basketTicket, evaluateSpecial, SPECIAL_MAX_PCT_PER_IDEA, type SpecialInput } from "../src/lib/special-situations";
import { scanFilingText } from "../src/lib/special-signals";

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

const GOPRO_TEXT = `These conditions raise substantial doubt about the Company's ability to continue as a
going concern. The Company was not in compliance with the financial covenants under the Credit
Agreements and received waivers. The Company has engaged financial advisors to evaluate a
potential sale or merger of the Company.`;

const GOPRO: SpecialInput = {
  symbol: "GPRO",
  marketCap: 125e6,
  revenue: 400e6,
  cash: 27.3e6,
  debt: 87.2e6,
  drawdownPct: -96,
  signals: scanFilingText(GOPRO_TEXT),
  recentStake: false,
  insiderBuys: 0,
};

console.log("\n# GoPro en agosto de 2026, antes del salto");
{
  const r = evaluateSpecial(GOPRO);
  truthy(r.score >= 70, `puntúa como apuesta (${r.score}/100)`);
  eq(r.tier, "apuesta", "nivel: apuesta");
  truthy(r.asymmetric, "apuro + catalizador");
  const cheap = r.components.find((c) => c.key === "cheap")!;
  truthy(cheap.value > 0.6, `barata: ${cheap.detail}`);
  truthy(r.reason.includes("EV/ventas") && r.reason.includes("-96%"), `razón con números: ${r.reason}`);
  truthy(r.risk.includes("cero"), "el riesgo dice que puede irse a cero");
  truthy(!/comprar|compra\b/i.test(r.reason), "nunca dice 'comprar'");
}

console.log("\n# lo mismo, pero después del 13D de septiembre");
{
  const r = evaluateSpecial({ ...GOPRO, recentStake: true });
  truthy(r.score > evaluateSpecial(GOPRO).score, "una participación nueva sube la puntuación");
}

console.log("\n# apuro sin catalizador NO es apuesta");
{
  const onlyDistress: SpecialInput = {
    ...GOPRO,
    signals: scanFilingText("There is substantial doubt about our ability to continue as a going concern."),
  };
  const r = evaluateSpecial(onlyDistress);
  truthy(!r.asymmetric, "no es asimétrico");
  truthy(r.tier !== "apuesta", `como mucho vigilar (${r.tier}, ${r.score})`);
  truthy(r.risk.includes("cero"), "y avisa del riesgo igual");
}

console.log("\n# barata y sana no es esto: eso es para el oráculo");
{
  const healthy: SpecialInput = {
    symbol: "OK",
    marketCap: 5e9,
    revenue: 8e9,
    cash: 1e9,
    debt: 0,
    drawdownPct: -15,
    signals: [],
    recentStake: false,
    insiderBuys: 0,
  };
  const r = evaluateSpecial(healthy);
  eq(r.tier, "nada", `una empresa normal no aparece aquí (${r.score})`);
}

console.log("\n# el catalizador ya consumado vale menos que el prometido");
{
  const done = evaluateSpecial({
    ...GOPRO,
    signals: scanFilingText("entered into a definitive merger agreement with Starman Optical. substantial doubt about going concern."),
  });
  const pending = evaluateSpecial(GOPRO);
  truthy(done.score < pending.score, `firmado (${done.score}) < buscando (${pending.score}): el salto ya pudo pasar`);
  truthy(done.components.find((c) => c.key === "catalyst")!.detail.includes("ya"), "y lo dice");
}

console.log("\n# sin datos no se inventa nada");
{
  const r = evaluateSpecial({ symbol: "X", marketCap: null, revenue: null, cash: null, debt: null, drawdownPct: null, signals: [], recentStake: false, insiderBuys: 0 });
  eq(r.tier, "nada", "sin datos, nada");
  truthy(r.components.every((c) => c.value === 0 || c.key === "distress"), "los componentes sin dato valen 0");
}

console.log("\n# tamaño de cesta: pequeño, fijo y con tope");
{
  eq(basketTicket(100_000, 0), 2000, `${SPECIAL_MAX_PCT_PER_IDEA}% de la cartera por idea`);
  eq(basketTicket(100_000, 7000), 1000, "y el tope de la cesta manda cuando queda menos");
  eq(basketTicket(100_000, 8000), 0, "cesta llena: nada más");
  eq(basketTicket(0, 0), 0, "sin cartera, nada");
  eq(basketTicket(20_000, 0), 400, "redondeado a la decena");
}

console.log(`\n${checks} comprobaciones, ${failures} fallos`);
process.exit(failures > 0 ? 1 : 0);
