/**
 * Genera el hash para AUTH_PASSWORD_HASH usando el auth compartido del
 * monorepo (@vault/auth), asi el formato es identico en todos los modulos.
 *
 *   npm run hash-password -- "mi-clave-larga"
 *
 * Copia la linea completa (empieza por "scrypt:") en la variable de entorno.
 * La contrasena en claro no se guarda en ningun sitio.
 */
import { randomBytes } from "node:crypto";
import { hashPassword } from "@vault/auth/password";

const password = process.argv[2];

if (!password) {
  console.error('Uso: npm run hash-password -- "tu-clave"');
  process.exit(1);
}

if (password.length < 12) {
  console.error(
    `La clave tiene ${password.length} caracteres. Usa 12 o mas: esto protege el acceso a tu vault entero.`,
  );
  process.exit(1);
}

console.log("\nAUTH_PASSWORD_HASH=" + hashPassword(password) + "\n");
console.log("Genera tambien los secretos que faltan (una vez, compartidos entre modulos):");
console.log("  AUTH_SECRET=" + randomBytes(32).toString("base64"));
console.log("  ENCRYPTION_KEY=" + randomBytes(32).toString("base64"));
console.log("  CRON_SECRET=" + randomBytes(32).toString("hex") + "\n");
