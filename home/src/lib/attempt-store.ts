import { createClient, type Client } from "@libsql/client";
import type { AttemptStore } from "@vault/auth/throttle";

/**
 * Rate limit del login del portal, sobre la misma tabla auth_attempts que ya
 * existe en la Turso del vault (la de invest). El portal no necesita mas DB
 * que esto; si algun dia se separa, basta apuntar TURSO_DATABASE_URL a otra.
 */

const globalForDb = globalThis as unknown as { __libsql?: Client };

function client(): Client {
  if (!globalForDb.__libsql) {
    const url = process.env.TURSO_DATABASE_URL;
    if (!url) throw new Error("Falta la variable de entorno TURSO_DATABASE_URL");
    globalForDb.__libsql = createClient({
      url,
      authToken: process.env.TURSO_AUTH_TOKEN || undefined,
    });
  }
  return globalForDb.__libsql;
}

export const attemptStore: AttemptStore = {
  async get(key) {
    const rs = await client().execute({
      sql: "select count, window_start from auth_attempts where key = ?",
      args: [key],
    });
    const row = rs.rows[0];
    if (!row) return null;
    return {
      count: Number(row.count ?? 0),
      windowStart: Number(row.window_start ?? 0),
    };
  },

  async set(key, record) {
    await client().execute({
      sql: `insert into auth_attempts (key, count, window_start) values (?, ?, ?)
            on conflict(key) do update set count = excluded.count, window_start = excluded.window_start`,
      args: [key, record.count, record.windowStart],
    });
  },

  async clear(key) {
    await client().execute({
      sql: "delete from auth_attempts where key = ?",
      args: [key],
    });
  },
};
