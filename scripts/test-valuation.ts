/**
 * Tests del modulo de valoracion (puro): tasa de descuento, DCF a dos etapas,
 * rango de escenarios, DCF inverso y margen de seguridad.
 * Correr con: npm run test:valuation
 */
import { dcf, dcfRange, discountRate, marginOfSafety, reverseDcf } from "../src/lib/valuation";

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

function inRange(v: number | null, lo: number, hi: number, label: string) {
  checks++;
  if (v === null || v < lo || v > hi) {
    failures++;
    console.error(`  FALLO ${label}: ${v} no esta en [${lo}, ${hi}]`);
  } else {
    console.log(`  ok  ${label} (${v})`);
  }
}

console.log("\n# discountRate (CAPM simplificado)");
{
  inRange(discountRate(4.0, 1.0), 8.4, 8.6, "bono 4% + prima 4.5% con beta 1");
  inRange(discountRate(4.0, 3.0), 11.1, 11.3, "beta acotado a 1.6");
  inRange(discountRate(null, null), 8.4, 8.6, "sin bono ni beta usa 4% y beta 1");
}

console.log("\n# dcf");
{
  // Sin crecimiento y descuento 8.5%: el valor ronda FCF / (r - g_terminal) ~ 10 / 0.06 = ~167.
  inRange(dcf({ fcfPerShare: 10, growthPct: 2.5, discountPct: 8.5 }), 150, 185, "perpetuidad aproximada sin crecimiento extra");
  const slow = dcf({ fcfPerShare: 10, growthPct: 5, discountPct: 8.5 })!;
  const fast = dcf({ fcfPerShare: 10, growthPct: 20, discountPct: 8.5 })!;
  truthy(fast > slow, "mas crecimiento, mas valor");
  const cheapMoney = dcf({ fcfPerShare: 10, growthPct: 10, discountPct: 7 })!;
  const dearMoney = dcf({ fcfPerShare: 10, growthPct: 10, discountPct: 10 })!;
  truthy(cheapMoney > dearMoney, "mas descuento, menos valor");
  truthy(dcf({ fcfPerShare: 0, growthPct: 10, discountPct: 8 }) === null, "sin FCF positivo no hay valor");
  const capped = dcf({ fcfPerShare: 10, growthPct: 80, discountPct: 8.5 })!;
  const atCap = dcf({ fcfPerShare: 10, growthPct: 30, discountPct: 8.5 })!;
  truthy(Math.abs(capped - atCap) < 0.01, "el crecimiento de etapa 1 se acota al 30%");
}

console.log("\n# dcfRange");
{
  const r = dcfRange({ fcfPerShare: 10, growthPct: 12, discountPct: 8.5 })!;
  truthy(r.bear < r.base && r.base < r.bull, `bajista ${r.bear} < base ${r.base} < alcista ${r.bull}`);
}

console.log("\n# reverseDcf (crecimiento implicito)");
{
  const base = { fcfPerShare: 10, discountPct: 8.5 };
  const fair = dcf({ ...base, growthPct: 12 })!;
  inRange(reverseDcf(fair, base), 11.5, 12.5, "recupera el crecimiento que produjo ese valor");
  inRange(reverseDcf(fair * 4, base), 40, 100, "un precio disparado implica un crecimiento enorme");
  truthy(reverseDcf(fair, { fcfPerShare: -1, discountPct: 8.5 }) === null, "sin FCF positivo no hay implicito");
}

console.log("\n# marginOfSafety");
{
  inRange(marginOfSafety(100, 75), 24.9, 25.1, "25% de margen cuando el precio es 3/4 del valor");
  inRange(marginOfSafety(100, 125), -25.1, -24.9, "negativo cuando cotiza por encima");
  truthy(marginOfSafety(null, 100) === null, "null sin valor");
}

console.log(`\n${failures === 0 ? "OK" : "FALLOS"}: ${checks - failures}/${checks} comprobaciones`);
process.exit(failures === 0 ? 0 : 1);
