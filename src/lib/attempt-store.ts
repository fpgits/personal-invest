import { eq } from "drizzle-orm";
import type { AttemptStore } from "@/lib/vault/throttle";
import { db } from "@/db";
import { authAttempts } from "@/db/schema";

/**
 * Implementacion del AttemptStore del auth compartido sobre la tabla
 * auth_attempts de este modulo. Cada modulo del vault cablea la suya;
 * la logica de ventanas y limites vive en src/lib/vault/throttle.
 */
export const attemptStore: AttemptStore = {
  async get(key) {
    const rows = await db
      .select()
      .from(authAttempts)
      .where(eq(authAttempts.key, key))
      .limit(1);
    const row = rows[0];
    return row ? { count: row.count, windowStart: row.windowStart } : null;
  },

  async set(key, record) {
    await db
      .insert(authAttempts)
      .values({ key, count: record.count, windowStart: record.windowStart })
      .onConflictDoUpdate({
        target: authAttempts.key,
        set: { count: record.count, windowStart: record.windowStart },
      });
  },

  async clear(key) {
    await db.delete(authAttempts).where(eq(authAttempts.key, key));
  },
};
