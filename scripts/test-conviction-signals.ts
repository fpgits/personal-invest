/**
 * Tests de la union de senales (puro, sin red ni base): que insiders, 13F,
 * eventos y tesis muevan el veredicto sin poder secuestrarlo.
 * Correr con: npm run test:signals
 */
import {
  collectModifiers,
  eventModifier,
  insiderModifier,
  managerModifier,
  scoreWithSignals,
  thesisModifier,
  SOURCE_CAP,
  TOTAL_CAP,
  type AssumptionLite,
  type EventLite,
  type InsiderLite,
} from "../src/lib/conviction-signals";

let failures = 0;
let checks = 0;

function eq<T>(actual: T, expected: T, label: string) {
  checks++;
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures++;
    console.error(`  FALLO ${label}: esperado ${JSON.stringify(expected)}, obtenido ${JSON.stringify(actual)}`);
  } else {
    console.log(`  ok  ${label}`);
  }
}

function truthy(v: unknown, label: string) {
  checks++;
  if (!v) {
    failures++;
    console.error(`  FALLO ${label}`);
  } else {
    console.log(`  ok  ${label}`);
  }
}

const ins = (kind: InsiderLite["kind"], totalValue = 100_000, owners = ["Ana"]): InsiderLite => ({
  kind,
  totalValue,
  owners,
  occurredAt: 1,
});

console.log("\n# insiders: comprar pesa mas que vender");
{
  const compra = insiderModifier([ins("cluster_buy", 2_000_000, ["Ana", "Luis", "Marta"])]);
  eq(compra?.points, 6, "compra agrupada: el tope de la fuente");
  truthy(compra?.detail.includes("3 directivo"), "dice cuantos y cuanto");

  const venta = insiderModifier([ins("big_sell", 2_000_000)]);
  eq(venta?.points, -3, "una venta grande pesa la mitad que una compra agrupada");
  truthy(
    Math.abs(venta!.points) < Math.abs(compra!.points),
    "vender por mil motivos no puede pesar como comprar por uno",
  );

  eq(insiderModifier([]), null, "sin señales, sin modificador");
}

console.log("\n# insiders: cuando se contradicen, se dice");
{
  const m = insiderModifier([ins("big_buy"), ins("big_sell")]);
  truthy(m?.detail.includes("no van a una"), "lo dice en vez de promediarlo en silencio");
}

console.log("\n# insiders: nada supera el tope de su fuente");
{
  const muchas = Array.from({ length: 20 }, () => ins("cluster_buy", 5_000_000));
  eq(insiderModifier(muchas)?.points, SOURCE_CAP.insiders, "veinte compras siguen topando en 6");
}

console.log("\n# 13F: el peso en la cartera del gestor modula");
{
  const grande = managerModifier([{ kind: "new", manager: "Burry", pct: 8, deltaPct: null }]);
  const chica = managerModifier([{ kind: "new", manager: "Burry", pct: 0.3, deltaPct: null }]);
  truthy(
    grande!.points > chica!.points,
    `una entrada del 8% pesa mas que una del 0,3% (${grande!.points} > ${chica!.points})`,
  );
  truthy(grande!.points <= SOURCE_CAP.managers, "y sin pasar del tope de la fuente");

  const salida = managerModifier([{ kind: "exit", manager: "Ackman", pct: 6, deltaPct: null }]);
  truthy(salida!.points < 0, "salir resta");
  truthy(salida!.detail.includes("Ackman"), "y dice quien");
}

console.log("\n# 13F: pesa menos que los insiders, a proposito");
{
  truthy(
    SOURCE_CAP.managers < SOURCE_CAP.insiders,
    "un 13F llega con 45 dias de retraso: no puede pesar como un Form 4",
  );
}

console.log("\n# eventos: solo P1-P3 y solo con impacto real");
{
  const ev = (priority: string, thesisImpact: number): EventLite => ({
    priority,
    thesisImpact,
    headline: `titular ${priority}`,
    occurredAt: 1,
  });
  eq(eventModifier([ev("P5", 90)]), null, "un P5 no mueve nada aunque grite");
  eq(eventModifier([ev("P1", 10)]), null, "un P1 con impacto pequeno tampoco");

  const malo = eventModifier([ev("P1", -80)]);
  truthy(malo!.points < 0, "un P1 malo resta");
  const p3 = eventModifier([ev("P3", -80)]);
  truthy(
    Math.abs(malo!.points) > Math.abs(p3!.points),
    `un P1 pesa mas que un P3 con el mismo impacto (${malo!.points} vs ${p3!.points})`,
  );

  const mezcla = eventModifier([ev("P1", 80), ev("P1", -80)]);
  truthy(mezcla === null || mezcla.detail.includes("se contradicen"), "si se anulan, se dice o no se aplica");
}

console.log("\n# tesis: un supuesto roto es lo que mas pesa de las cuatro");
{
  const a = (status: string, statement = "Los margenes se mantienen"): AssumptionLite => ({ statement, status });
  const roto = thesisModifier([a("broken"), a("on_track"), a("on_track")]);
  truthy(roto!.points < 0, "un roto manda sobre dos que van bien");
  truthy(roto!.detail.includes("ROTO"), "y lo dice con el supuesto entre comillas");

  const bien = thesisModifier([a("on_track"), a("on_track")]);
  truthy(bien!.points > 0, "supuestos cumpliendose suman");
  eq(thesisModifier([a("unknown"), a("unknown")]), null, "sin medir, no opina");
}

console.log("\n# la union: los fundamentales mandan");
{
  const todo = collectModifiers({
    insiders: [ins("cluster_buy", 5_000_000, ["A", "B", "C"])],
    managers: [{ kind: "new", manager: "Burry", pct: 9, deltaPct: null }],
    events: [{ priority: "P1", thesisImpact: 90, headline: "gran contrato", occurredAt: 1 }],
    assumptions: [{ statement: "crece", status: "on_track" }],
  });
  truthy(todo.total <= TOTAL_CAP, `cuatro fuentes al maximo topan en ${TOTAL_CAP} (dieron ${todo.total})`);
  eq(todo.modifiers.length, 4, "las cuatro entran");
  eq(todo.conflict, false, "todas apuntan igual: sin conflicto");
  truthy(todo.lines.every((l) => /^[+-]?\d/.test(l)), "cada linea empieza por sus puntos");

  // Una empresa mediocre no se vuelve buena por mucho insider que compre.
  eq(scoreWithSignals(45, todo.total), 57, "45 + 12 = 57: sigue sin ser una compra");
}

console.log("\n# la union: el conflicto se marca, no se promedia");
{
  const v = collectModifiers({
    insiders: [ins("cluster_buy", 3_000_000, ["A", "B"])],
    assumptions: [{ statement: "el margen aguanta", status: "broken" }],
  });
  eq(v.conflict, true, "directivos comprando y tesis rota: conflicto");
  eq(v.modifiers.length, 2, "los dos siguen visibles por separado");
  truthy(
    v.modifiers[0].label !== v.modifiers[1].label,
    "ordenados por peso, cada uno con su linea",
  );
}

console.log("\n# la union: sin datos no pasa nada");
{
  const vacio = collectModifiers({});
  eq(vacio.total, 0, "sin señales el score no se toca");
  eq(vacio.modifiers.length, 0, "y no inventa modificadores");
  eq(scoreWithSignals(64, 0), 64, "el score queda igual");
}

console.log("\n# el score nunca se sale de 0..100");
{
  eq(scoreWithSignals(96, 12), 100, "no pasa de 100");
  eq(scoreWithSignals(3, -12), 0, "no baja de 0");
}

console.log(`\n${checks} comprobaciones, ${failures} fallos`);
process.exit(failures > 0 ? 1 : 0);
