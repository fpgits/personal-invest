import { SignJWT, jwtVerify } from "jose";

/**
 * Sesion compartida del vault.
 *
 * Este modulo es edge-safe (solo jose y Web Crypto): lo importan tanto los
 * route handlers como el proxy/middleware de cada modulo. Nada de node:crypto
 * aqui; eso vive en ./password.
 *
 * El nombre de cookie y el secreto son los mismos en todos los modulos, asi
 * que una sesion iniciada en uno vale en cualquiera. Compartir la sesion
 * entre subdominios distintos requiere ademas AUTH_COOKIE_DOMAIN (ver abajo).
 */

export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 dias

/**
 * En produccion el nombre lleva el prefijo __Secure-: el navegador solo
 * acepta la cookie por HTTPS y ningun subdominio inseguro puede pisarla.
 * (__Host- seria aun mas estricto pero prohibe Domain, y el SSO entre
 * subdominios necesita Domain.)
 */
export function sessionCookieName(isProduction: boolean): string {
  return isProduction ? "__Secure-vault_session" : "vault_session";
}

export type CookieAttributes = {
  httpOnly: true;
  secure: boolean;
  sameSite: "lax";
  path: "/";
  maxAge: number;
  domain?: string;
};

/**
 * Atributos de la cookie de sesion.
 *
 * `domain` (AUTH_COOKIE_DOMAIN) queda vacio mientras cada modulo viva en
 * *.vercel.app: vercel.app esta en la Public Suffix List y los navegadores
 * rechazan cookies de dominio compartido ahi. El dia que el vault tenga
 * dominio propio (invest.tudominio.com, notas.tudominio.com), se pone
 * AUTH_COOKIE_DOMAIN=".tudominio.com" en todos los modulos y el login pasa
 * a ser una sola sesion para todo.
 */
export function sessionCookieAttributes(opts: {
  isProduction: boolean;
  domain?: string;
}): CookieAttributes {
  return {
    httpOnly: true,
    secure: opts.isProduction,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
    ...(opts.domain ? { domain: opts.domain } : {}),
  };
}

function encodeSecret(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

export async function createSessionToken(secret: string): Promise<string> {
  return new SignJWT({ sub: "owner" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_MAX_AGE_SECONDS}s`)
    .sign(encodeSecret(secret));
}

export async function verifySessionToken(
  token: string,
  secret: string,
): Promise<boolean> {
  try {
    await jwtVerify(token, encodeSecret(secret));
    return true;
  } catch {
    return false;
  }
}
