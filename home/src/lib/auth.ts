import { cookies } from "next/headers";
import {
  createSessionToken,
  sessionCookieAttributes,
  sessionCookieName,
  verifySessionToken,
} from "@vault/auth/session";
import { verifyPassword } from "@vault/auth/password";

/**
 * Cableado del auth compartido para el portal. Identico al de invest a
 * proposito: misma cookie, mismo secreto, misma sesion.
 */

const isProduction = process.env.NODE_ENV === "production";

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Falta la variable de entorno ${name}`);
  return v;
}

export function cookieName(): string {
  return sessionCookieName(isProduction);
}

export async function login(password: string): Promise<boolean> {
  if (!verifyPassword(password, req("AUTH_PASSWORD_HASH"))) return false;
  const token = await createSessionToken(req("AUTH_SECRET"));
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
  return verifySessionToken(token, req("AUTH_SECRET"));
}
