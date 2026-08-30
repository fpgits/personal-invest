import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { env } from "./env";

/**
 * Cifrado de las API keys de exchanges antes de guardarlas en Turso.
 * AES-256-GCM, IV aleatorio por registro, tag de autenticacion incluido.
 * Formato guardado: base64(iv).base64(tag).base64(ciphertext)
 */

function key(): Buffer {
  const raw = Buffer.from(env.encryptionKey, "base64");
  if (raw.length !== 32) {
    throw new Error(
      "ENCRYPTION_KEY debe ser 32 bytes en base64. Genera uno con: openssl rand -base64 32",
    );
  }
  return raw;
}

export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    iv.toString("base64"),
    tag.toString("base64"),
    ct.toString("base64"),
  ].join(".");
}

export function decrypt(payload: string): string {
  const [ivB64, tagB64, ctB64] = payload.split(".");
  if (!ivB64 || !tagB64 || !ctB64) throw new Error("Payload cifrado invalido");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key(),
    Buffer.from(ivB64, "base64"),
  );
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(ctB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

/** Solo revela los ultimos 4 caracteres, para mostrar en la UI. */
export function maskKey(payload: string | null): string | null {
  if (!payload) return null;
  try {
    const plain = decrypt(payload);
    return plain.length <= 4 ? "****" : `****${plain.slice(-4)}`;
  } catch {
    return "****";
  }
}

/* ---------- password hashing (scrypt, sin dependencias) ---------- */

/*
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
