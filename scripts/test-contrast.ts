/**
 * Contraste de los dos temas. Correr con: npm run test:contrast
 *
 * Existe por un fallo real: en el tema oscuro los botones salieron blancos con
 * la letra blanca. La causa fue usar `text-white` sobre `bg-accent`, y en
 * oscuro el acento ES casi blanco. Un ojo revisando capturas no coge eso a
 * tiempo; una cuenta si.
 *
 * Dos reglas, las dos automaticas:
 *  1. Nadie escribe `text-white` sobre un fondo que cambia con el tema. El
 *     token correcto es `text-bg`, que se invierte solo.
 *  2. Cada chip de color con la etiqueta en `text-bg` encima llega a 4.5:1 en
 *     los DOS temas (WCAG AA para texto pequeno, que es lo que son).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

let failures = 0;
let checks = 0;

function truthy(cond: boolean, label: string) {
  checks++;
  if (cond) {
    console.log(`  ok  ${label}`);
  } else {
    failures++;
    console.log(`  FALLA  ${label}`);
  }
}

/** Fondos que se invierten con el tema: encima de ellos, blanco fijo es un bug. */
const THEMED_BACKGROUNDS = ["bg-accent", "bg-up", "bg-down", "bg-warn"];
const AA_SMALL = 4.5;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".tsx") || p.endsWith(".ts")) out.push(p);
  }
  return out;
}

function relativeLuminance(hex: string): number {
  const chan = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * chan[0] + 0.7152 * chan[1] + 0.0722 * chan[2];
}

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function tokensIn(block: string): Record<string, string> {
  return Object.fromEntries(
    [...block.matchAll(/--color-([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})/g)].map((m) => [m[1], m[2]]),
  );
}

const css = readFileSync("src/app/globals.css", "utf8");
const light = tokensIn(css.match(/@theme\s*\{([\s\S]*?)\n\}/)?.[1] ?? "");
const dark = { ...light, ...tokensIn(css.match(/html\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/)?.[1] ?? "") };

console.log("\n# los tokens de los dos temas se leen");
truthy(Object.keys(light).length > 8, `tema claro: ${Object.keys(light).length} colores`);
truthy(dark.bg !== light.bg, "el tema oscuro redefine el fondo");

console.log("\n# nadie fija el blanco sobre un fondo que cambia con el tema");
const offenders: string[] = [];
for (const file of walk("src")) {
  const src = readFileSync(file, "utf8");
  for (const line of src.split("\n")) {
    if (!line.includes("text-white")) continue;
    if (THEMED_BACKGROUNDS.some((bg) => line.includes(bg))) offenders.push(`${file}: ${line.trim().slice(0, 70)}`);
  }
}
truthy(offenders.length === 0, `sin text-white sobre fondos con tema${offenders.length ? `\n      ${offenders.join("\n      ")}` : ""}`);

for (const [name, theme] of [["claro", light] as const, ["oscuro", dark] as const]) {
  console.log(`\n# tema ${name}: la etiqueta se lee encima del chip`);
  for (const bg of THEMED_BACKGROUNDS) {
    const token = bg.replace("bg-", "");
    const ratio = contrastRatio(theme[token], theme.bg);
    truthy(
      ratio >= AA_SMALL,
      `${bg} (${theme[token]}) con text-bg (${theme.bg}) = ${ratio.toFixed(2)}:1`,
    );
  }
}

console.log(`\n${checks} comprobaciones, ${failures} fallos`);
process.exit(failures > 0 ? 1 : 0);
