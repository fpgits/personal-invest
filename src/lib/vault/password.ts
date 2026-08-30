import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/**
 * Hash y verificacion de la contrasena unica del vault. Solo Node runtime.
 *
 * Formato: scrypt:<salt base64>:<hash base64>
 *
 * El separador es ":" y no "$" a proposito. Next expande variables dentro de
 * los ficheros .env, asi que un "$" en el valor se come el resto del token y
 * el login falla en silencio aun con la contrasena correcta. El alfabeto
 * base64 no contiene ":", asi que este separador nunca colisiona.
 */

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, 64);
  return `scrypt:${salt.toString("base64")}:${derived.toString("base64")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [algo, saltB64, hashB64] = stored.trim().split(":");
  if (algo !== "scrypt" || !saltB64 || !hashB64) return false;

  const expected = Buffer.from(hashB64, "base64");
  if (expected.length === 0) return false;

  const derived = scryptSync(
    password,
    Buffer.from(saltB64, "base64"),
    expected.length,
  );
  return expected.length === derived.length && timingSafeEqual(expected, derived);
}
