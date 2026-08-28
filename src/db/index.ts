import { createClient, type Client } from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import { env } from "@/lib/env";
import * as schema from "./schema";

/**
 * Cliente perezoso. Importar este modulo no debe exigir que existan las
 * variables de entorno: Next las necesita en runtime, no al recolectar las
 * rutas durante el build. Ademas permite testear el motor de P&L sin Turso.
 */
const globalForDb = globalThis as unknown as {
  __libsql?: Client;
  __drizzle?: LibSQLDatabase<typeof schema>;
};

function connect(): LibSQLDatabase<typeof schema> {
  if (globalForDb.__drizzle) return globalForDb.__drizzle;

  const client =
    globalForDb.__libsql ??
    createClient({
      url: env.tursoUrl,
      authToken: env.tursoToken || undefined,
    });

  const instance = drizzle(client, { schema });
  globalForDb.__libsql = client;
  globalForDb.__drizzle = instance;
  return instance;
}

/**
 * Se comporta como el objeto de drizzle, pero solo abre la conexion la
 * primera vez que alguien lo usa de verdad.
 */
export const db = new Proxy({} as LibSQLDatabase<typeof schema>, {
  get(_target, prop, receiver) {
    return Reflect.get(connect(), prop, receiver);
  },
});

export { schema };
