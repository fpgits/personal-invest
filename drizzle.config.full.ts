import "dotenv/config";
import { defineConfig } from "drizzle-kit";

/**
 * El config que usan de verdad los scripts de `package.json`.
 *
 * Existe por una razon tonta con consecuencias caras: `drizzle.config.ts` esta
 * en SOLO LECTURA en este equipo y sigue apuntando a un unico archivo de
 * schema. Con esa lista, `drizzle-kit generate` no ve las tablas que viven en
 * `schema-runups.ts` — los episodios historicos y los dos libros de PoWERo —,
 * cree que sobran y genera un DROP para todas ellas. Correr `db:generate` una
 * vez bastaria para borrar el registro entero del oraculo de papel.
 *
 * Aqui estan TODOS los archivos de schema. Si algun dia hay uno mas, se añade
 * a este array. El `drizzle.config.ts` de al lado se queda como esta: ya no lo
 * usa nadie.
 */
export default defineConfig({
  schema: ["./src/db/schema.ts", "./src/db/schema-runups.ts"],
  out: "./drizzle",
  dialect: "turso",
  dbCredentials: {
    url: process.env.TURSO_DATABASE_URL!,
    authToken: process.env.TURSO_AUTH_TOKEN,
  },
  verbose: true,
  strict: true,
});
