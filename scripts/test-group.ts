/**
 * Tests del filtro por grupo (puro): parseo de la cookie, mapeo de clase y de
 * cuenta a grupo, y las funciones de pertenencia que usan Cartera, Alertas,
 * Noticias y el Resumen.
 * Correr con: npm run test:group
 */
import {
  accountGroup,
  accountInGroup,
  classInGroup,
  groupOfClass,
  GROUP_KEYS,
  parseGroup,
} from "../src/lib/group";

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

console.log("\n# parseGroup");
{
  eq(parseGroup("bolsa"), "bolsa", "bolsa");
  eq(parseGroup("cripto"), "cripto", "cripto");
  eq(parseGroup("all"), "all", "all");
  eq(parseGroup(null), "all", "null → all");
  eq(parseGroup(undefined), "all", "undefined → all");
  eq(parseGroup(""), "all", "vacio → all");
  eq(parseGroup("BOLSA"), "all", "mayusculas no valen → all (nunca oculta por accidente)");
  eq(parseGroup("equity"), "all", "una clase no es un grupo → all");
  eq(GROUP_KEYS, ["all", "bolsa", "cripto"], "orden de los grupos");
}

console.log("\n# groupOfClass / accountGroup");
{
  eq(groupOfClass("crypto"), "cripto", "crypto → cripto");
  eq(groupOfClass("equity"), "bolsa", "equity → bolsa");
  eq(groupOfClass("etf"), "bolsa", "etf → bolsa");
  eq(groupOfClass("cash"), "bolsa", "cash cae en bolsa por clase (el matiz broker/exchange lo da la cuenta)");
  eq(accountGroup("exchange"), "cripto", "exchange → cripto");
  eq(accountGroup("broker"), "bolsa", "broker → bolsa");
  eq(accountGroup(null), "bolsa", "sin tipo → bolsa");
}

console.log("\n# classInGroup (activos)");
{
  eq(classInGroup("all", "crypto"), true, "all no filtra (crypto)");
  eq(classInGroup("all", "equity"), true, "all no filtra (equity)");
  eq(classInGroup("bolsa", "equity"), true, "bolsa acepta equity");
  eq(classInGroup("bolsa", "etf"), true, "bolsa acepta etf");
  eq(classInGroup("bolsa", "crypto"), false, "bolsa rechaza crypto");
  eq(classInGroup("cripto", "crypto"), true, "cripto acepta crypto");
  eq(classInGroup("cripto", "equity"), false, "cripto rechaza equity");
}

console.log("\n# accountInGroup (cuentas / aportes)");
{
  eq(accountInGroup("all", "exchange"), true, "all no filtra");
  eq(accountInGroup("all", "broker"), true, "all no filtra");
  eq(accountInGroup("bolsa", "broker"), true, "bolsa acepta broker (IBKR)");
  eq(accountInGroup("bolsa", "exchange"), false, "bolsa rechaza exchange");
  eq(accountInGroup("cripto", "exchange"), true, "cripto acepta exchange (Binance)");
  eq(accountInGroup("cripto", "broker"), false, "cripto rechaza broker");
}

console.log(`\n${checks} comprobaciones, ${failures} fallos`);
process.exit(failures > 0 ? 1 : 0);
