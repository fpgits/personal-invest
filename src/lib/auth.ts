import { cookies } from "next/headers";
import { SignJWT, jwtVerify } from "jose";
import { env } from "./env";
import { verifyPassword } from "./crypto";

const COOKIE = "inv_session";
const MAX_AGE = 60 * 60 * 24 * 30; // 30 dias

function secret() {
  return new TextEncoder().encode(env.authSecret);
}

export async function createSession(): Promise<string> {
  return new SignJWT({ sub: "owner" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${MAX_AGE}s`)
    .sign(secret());
}

export async function login(password: string): Promise<boolean> {
  if (!verifyPassword(password, env.authHash)) return false;
  const token = await createSession();
  const jar = await cookies();
  jar.set(COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: MAX_AGE,
  });
  return true;
}

export async function logout() {
  const jar = await cookies();
  jar.delete(COOKIE);
}

export async function isAuthenticated(): Promise<boolean> {
  const jar = await cookies();
  const token = jar.get(COOKIE)?.value;
  if (!token) return false;
  try {
    await jwtVerify(token, secret());
    return true;
  } catch {
    return false;
  }
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

export const SESSION_COOKIE = COOKIE;
