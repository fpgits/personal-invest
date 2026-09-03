import { cookies } from "next/headers";
import { GROUP_COOKIE, parseGroup, type GroupKey } from "./group";

/**
 * El grupo elegido (Todo/Bolsa/Cripto), leido de la cookie que escribe el
 * selector. Solo para componentes de servidor y route handlers.
 */
export async function readGroup(): Promise<GroupKey> {
  const jar = await cookies();
  return parseGroup(jar.get(GROUP_COOKIE)?.value);
}
