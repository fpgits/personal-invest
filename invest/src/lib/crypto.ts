import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
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
