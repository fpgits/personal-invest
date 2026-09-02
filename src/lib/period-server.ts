import { cookies } from "next/headers";
import { parseSpec, PERIOD_COOKIE, resolveStored, todayUtc, type PeriodSpec, type ResolvedPeriod } from "./period";

/**
 * El periodo elegido, leido de la cookie que escribe el selector. Solo para
 * componentes de servidor y route handlers.
 */
export async function readPeriod(): Promise<{ spec: PeriodSpec; period: ResolvedPeriod }> {
  const jar = await cookies();
  const spec = parseSpec(jar.get(PERIOD_COOKIE)?.value);
  return { spec, period: resolveStored(spec, todayUtc()) };
}
