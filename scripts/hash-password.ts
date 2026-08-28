/**
 * Genera el hash para AUTH_PASSWORD_HASH.
 *
 *   npm run hash-password -- "mi-clave-larga"
 *
 * Copia la linea completa (empieza por "scrypt:") en la variable de entorno.
 * La contrasena en claro no se guarda en ningun sitio.
 */
import { randomBytes, scryptSync } from "node:crypto";

const password = process.argv[2];

if (!password) {
  console.error('Uso: npm run hash-password -- "tu-clave"');
  process.exit(1);
}

if (password.length < 10) {
  console.error(
    `La clave tiene ${password.length} caracteres. Usa 12 o mas: esto protege el acceso a tu cartera entera.`,
  );
  process.exit(1);
}

const salt = randomBytes(16);
const derived = scryptSync(password, salt, 64);
const hash = `scrypt:${salt.toString("base64")}:${derived.toString("base64")}`;

console.log("\nAUTH_PASSWORD_HASH=" + hash + "\n");
console.log("Genera tambien los secretos que faltan:");
console.log("  AUTH_SECRET=" + randomBytes(32).toString("base64"));
console.log("  ENCRYPTION_KEY=" + randomBytes(32).toString("base64"));
console.log("  CRON_SECRET=" + randomBytes(32).toString("hex") + "\n");
