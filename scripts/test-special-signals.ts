/**
 * Tests del escáner de señales de situación especial en filings (puro).
 * El fixture principal es el lenguaje REAL del 10-Q de GoPro del segundo
 * trimestre de 2026, que anunciaba el escenario un mes antes del salto.
 * Correr con: npm run test:special-signals
 */
import { describeSignals, isAsymmetricSetup, scanFilingText } from "../src/lib/special-signals";

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

// Frases tal como aparecen en el 10-Q de GoPro (Q2 2026), reordenadas.
const GOPRO_10Q = `
Liquidity and Going Concern. Revenue for the three months ended June 30, 2026 was
$104.9 million, a decrease of 31.3% compared to the same period in 2025. These
conditions, considered in the aggregate, raise substantial doubt about the
Company's ability to continue as a going concern. As of June 30, 2026, the
Company was not in compliance with the financial covenants under both the 2021
Credit Agreement and the 2025 Credit Agreement. On July 9, 2026 the Company
received waivers from the lenders with respect to such covenant defaults and is
required to repay $24.4 million under the 2021 Credit Agreement within 180 days.
The Company has engaged financial advisors to evaluate a potential sale or
merger of the Company and is exploring opportunities in the defense and
aerospace markets. Management's plans have not alleviated the substantial doubt.
`;

console.log("\n# el 10-Q de GoPro: apuro y catalizador a la vez");
{
  const s = scanFilingText(GOPRO_10Q);
  const keys = s.map((x) => x.key);
  truthy(keys.includes("going_concern"), "going concern");
  truthy(keys.includes("covenant_breach"), "covenants incumplidos");
  truthy(keys.includes("sale_or_merger"), "busca venta o fusión");
  truthy(keys.includes("advisors_engaged"), "asesores contratados");
  truthy(!keys.includes("definitive_agreement"), "todavía no hay acuerdo firmado (eso llegó en septiembre)");
  truthy(isAsymmetricSetup(s), "es un escenario asimétrico: apuro + catalizador");
  const gc = s.find((x) => x.key === "going_concern")!;
  truthy(gc.quote.includes("substantial doubt"), `la cita lleva la frase real: ${gc.quote.slice(0, 80)}…`);
  eq(new Set(keys).size, keys.length, "una señal por clave, sin repetir");
  const desc = describeSignals(s);
  truthy(desc.startsWith("apuro:") && desc.includes("catalizador:"), `resumen legible: ${desc}`);
}

console.log("\n# el 8-K de la fusión: ya hay acuerdo");
{
  const text = `GoPro, Inc. announced today that it has entered into a definitive merger agreement
  with Starman Optical, Inc. Under the Agreement and Plan of Merger, Starman will acquire...`;
  const s = scanFilingText(text);
  truthy(s.some((x) => x.key === "definitive_agreement"), "acuerdo definitivo detectado");
  truthy(!isAsymmetricSetup(s), "sin señal de apuro en este texto, no es 'setup' sino 'ya pasó'");
}

console.log("\n# participación grande (lo que un 13D cuenta)");
{
  const s = scanFilingText("The Reporting Person beneficially owns 8.5% of the outstanding Class A common stock.");
  truthy(s.some((x) => x.key === "large_stake"), "8,5% cuenta");
  const small = scanFilingText("The Reporting Person beneficially owns 2.1% of the outstanding shares.");
  truthy(!small.some((x) => x.key === "large_stake"), "un 2,1% no");
}

console.log("\n# apuro sin catalizador no es una oportunidad");
{
  const s = scanFilingText("There is substantial doubt about our ability to continue as a going concern. We received a Nasdaq deficiency notice regarding the minimum bid price requirement.");
  truthy(s.some((x) => x.key === "going_concern") && s.some((x) => x.key === "delisting_risk"), "dos señales de apuro");
  truthy(!isAsymmetricSetup(s), "sin catalizador no es asimétrico: es solo una empresa en problemas");
}

console.log("\n# lo normal no dispara nada");
{
  const boring = `Revenue increased 12% year over year driven by strong demand. We remain in
  compliance with all covenants. Our board continues to evaluate capital allocation, including
  share repurchases. We believe our cash is sufficient to fund operations for the next twelve months.`;
  eq(scanFilingText(boring), [], "un 10-Q sano no tiene señales");
  eq(scanFilingText(""), [], "vacío");
}

console.log(`\n${checks} comprobaciones, ${failures} fallos`);
process.exit(failures > 0 ? 1 : 0);
