import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

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

/**
 * Normaliza el valor tal como suele llegar desde un dashboard de env vars:
 * espacios o saltos de linea alrededor, comillas envolventes de un copy-paste,
 * y el separador "$" del formato antiguo del script (hoy es ":").
 */
export function normalizeStoredHash(stored: string): string {
  return stored.trim().replace(/^["']+|["']+$/g, "");
}

export function verifyPassword(password: string, stored: string): boolean {
  const cleaned = normalizeStoredHash(stored);
  const parts = cleaned.split(cleaned.includes(":") ? ":" : "$");
  const [algo, saltB64, hashB64] = parts;
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

/**
 * Comparacion de contrasena en claro (AUTH_PASSWORD) en tiempo constante.
 * Se hashea cada lado con sha256 para igualar longitudes antes de comparar;
 * asi timingSafeEqual no filtra la longitud de la clave.
 */
export function verifyPlainPassword(password: string, expected: string): boolean {
  const cleaned = normalizeStoredHash(expected);
  if (!cleaned) return false;
  const a = createHash("sha256").update(password).digest();
  const b = createHash("sha256").update(cleaned).digest();
  return timingSafeEqual(a, b);
}
