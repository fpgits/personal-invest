import { cookies } from "next/headers";
import {
  createSessionToken,
  sessionCookieAttributes,
  sessionCookieName,
  verifySessionToken,
} from "@/lib/vault/session";
import { verifyPassword, verifyPlainPassword } from "@/lib/vault/password";
import { env } from "./env";

/**
 * Cableado del auth del vault (src/lib/vault) para toda la app.
 * El nombre de cookie, el formato de sesion y el secreto son comunes a todo
 * el monorepo: cualquier modulo con el mismo AUTH_SECRET acepta esta sesion.
 */

const isProduction = process.env.NODE_ENV === "production";

export function cookieName(): string {
  return sessionCookieName(isProduction);
}

/**
 * Dos formas de configurar la llave del vault, a eleccion:
 * - AUTH_PASSWORD: la contrasena tal cual en la env var. Simple.
 * - AUTH_PASSWORD_HASH: el hash scrypt (npm run hash-password). Si alguien ve
 *   tus env vars o un pantallazo, no aprende la contrasena.
 * Si ambas existen, manda AUTH_PASSWORD.
 */
function checkPassword(password: string): boolean {
  const plain = env.authPassword;
  if (plain) return verifyPlainPassword(password, plain);
  return verifyPassword(password, env.authHash);
}

export async function login(password: string): Promise<boolean> {
  if (!checkPassword(password)) return false;
  const token = await createSessionToken(env.authSecret);
  const jar = await cookies();
  jar.set(
    cookieName(),
    token,
    sessionCookieAttributes({
      isProduction,
      domain: process.env.AUTH_COOKIE_DOMAIN || undefined,
    }),
  );
  return true;
}

export async function logout() {
  const jar = await cookies();
  jar.delete({
    name: cookieName(),
    path: "/",
    domain: process.env.AUTH_COOKIE_DOMAIN || undefined,
  });
}

export async function isAuthenticated(): Promise<boolean> {
  const jar = await cookies();
  const token = jar.get(cookieName())?.value;
  if (!token) return false;
  return verifySessionToken(token, env.authSecret);
}

/** Para route handlers: corta con 401 si no hay sesion. */
export async function requireAuth(): Promise<Response | null> {
  if (await isAuthenticated()) return null;
  return Response.json({ error: "No autorizado" }, { status: 401 });
}

/** Los endpoints de cron se autentican con CRON_SECRET, no con la cookie. */
export function isCronAuthorized(req: Request): boolean {
  const secretValue = env.cronSecret;
  if (!secretValue) return false;
  const header = req.headers.get("authorization");
  return header === `Bearer ${secretValue}`;
}
