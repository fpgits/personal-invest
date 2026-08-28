/**
 * Comprobacion de configuracion. Sirve para que la app explique que le falta
 * en vez de reventar con un stack trace cuando aun no has puesto las claves.
 */
export type SetupCheck = {
  key: string;
  label: string;
  ok: boolean;
  required: boolean;
  hint: string;
};

export function checkSetup(): SetupCheck[] {
  const has = (k: string) => Boolean(process.env[k]?.trim());

  return [
    {
      key: "TURSO_DATABASE_URL",
      label: "Base de datos Turso",
      ok: has("TURSO_DATABASE_URL"),
      required: true,
      hint: "libsql://... del panel de Turso",
    },
    {
      key: "AUTH_SECRET",
      label: "Secreto de sesion",
      ok: has("AUTH_SECRET"),
      required: true,
      hint: "openssl rand -base64 32",
    },
    {
      key: "AUTH_PASSWORD_HASH",
      label: "Contrasena de acceso",
      ok: has("AUTH_PASSWORD_HASH"),
      required: true,
      hint: 'npm run hash-password -- "tu-clave"',
    },
    {
      key: "ENCRYPTION_KEY",
      label: "Clave de cifrado",
      ok: has("ENCRYPTION_KEY"),
      required: true,
      hint: "openssl rand -base64 32. Cifra las API keys de exchanges.",
    },
    {
      key: "OPENROUTER_API_KEY",
      label: "OpenRouter",
      ok: has("OPENROUTER_API_KEY"),
      required: false,
      hint: "Sin esto no hay analisis ni resumenes de noticias.",
    },
    {
      key: "FINNHUB_API_KEY",
      label: "Finnhub (bolsa)",
      ok: has("FINNHUB_API_KEY"),
      required: false,
      hint: "Sin esto no hay precios ni noticias de acciones.",
    },
    {
      key: "COINGECKO_API_KEY",
      label: "CoinGecko (cripto)",
      ok: has("COINGECKO_API_KEY"),
      required: false,
      hint: "Opcional. Sin key funciona a 5-15 req/min en vez de 30.",
    },
    {
      key: "CRON_SECRET",
      label: "Cron de Vercel",
      ok: has("CRON_SECRET"),
      required: false,
      hint: "Sin esto los cron devuelven 401 y no hay snapshots diarios.",
    },
  ];
}

export function missingRequired(): SetupCheck[] {
  return checkSetup().filter((c) => c.required && !c.ok);
}
