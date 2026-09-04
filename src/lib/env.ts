/** Lectura centralizada de env. Falla ruidosamente cuando falta algo critico. */

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Falta la variable de entorno ${name}`);
  return v;
}

function opt(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

export const env = {
  get tursoUrl() {
    return req("TURSO_DATABASE_URL");
  },
  get tursoToken() {
    return opt("TURSO_AUTH_TOKEN");
  },
  get openrouterKey() {
    return req("OPENROUTER_API_KEY");
  },
  get modelAnalysis() {
    return opt("OPENROUTER_MODEL_ANALYSIS", "google/gemini-3.7-flash");
  },
  get modelFast() {
    return opt("OPENROUTER_MODEL_FAST", "deepseek/deepseek-v4-flash");
  },
  get siteUrl() {
    return opt("OPENROUTER_SITE_URL", "http://localhost:3000");
  },
  get siteName() {
    return opt("OPENROUTER_SITE_NAME", "Fernando Portela");
  },
  /**
   * Tope diario en USD para las llamadas de fondo (resumenes, eventos,
   * propuestas de tesis). Se puede cambiar en Ajustes sin redeploy; 0 = sin
   * limite. Lo que pides a mano (chat, riesgo, tesis) nunca se bloquea.
   */
  get aiDailyBudgetUsd() {
    return opt("AI_DAILY_BUDGET_USD");
  },
  get finnhubKey() {
    return opt("FINNHUB_API_KEY");
  },
  get coingeckoKey() {
    return opt("COINGECKO_API_KEY");
  },
  /** Datos macro de la Reserva Federal (FRED). Sin clave, el panel macro se oculta. */
  get fredKey() {
    return opt("FRED_API_KEY");
  },
  /** Alternativa simple: la contrasena tal cual en AUTH_PASSWORD. */
  get authPassword() {
    return opt("AUTH_PASSWORD");
  },
  get authHash() {
    const raw = req("AUTH_PASSWORD_HASH").trim().replace(/^["']+|["']+$/g, "");
    /*
     * Si el valor no tiene forma de hash (scrypt:salt:hash), fallar ruidoso:
     * sin esto, una contrasena en claro o un pegado a medias en la env var
     * produce un 401 identico al de "contrasena incorrecta" y es indebugeable.
     */
    if (!/^scrypt[:$][A-Za-z0-9+/=]+[:$][A-Za-z0-9+/=]+$/.test(raw)) {
      throw new Error(
        "AUTH_PASSWORD_HASH no es un hash valido. Causas tipicas: pusiste la contrasena en claro, el pegado quedo incompleto, o el hash es del formato viejo con $ (el runtime expande $ y lo corrompe). Regeneralo con `npm run hash-password`, reemplaza la env var en Vercel y redeploy.",
      );
    }
    return raw;
  },
  get authSecret() {
    return req("AUTH_SECRET");
  },
  get encryptionKey() {
    return req("ENCRYPTION_KEY");
  },
  get coingeckoPro() {
    return opt("COINGECKO_PRO") === "true";
  },
  get cronSecret() {
    return opt("CRON_SECRET");
  },
  get baseCurrency() {
    return opt("BASE_CURRENCY", "USD");
  },
  /**
   * La SEC exige identificarse en el User-Agent (nombre y email de contacto)
   * para usar EDGAR; sin ello responde 403. No es una clave: solo cortesia.
   */
  get secContactEmail() {
    return opt("SEC_CONTACT_EMAIL");
  },
  /** Opcional: sube el limite de OpenFIGI (CUSIP → ticker) de 25 a 250 req/min. */
  get openfigiKey() {
    return opt("OPENFIGI_API_KEY");
  },
};
