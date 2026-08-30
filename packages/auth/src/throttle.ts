/**
 * Rate limit de login con ventana fija, sobre un almacen que aporta cada
 * modulo (en la practica, una tabla en su Turso). El paquete no conoce la DB:
 * define el contrato y la logica, el modulo cablea las tres funciones.
 *
 * Por que en DB y no en memoria: en serverless cada instancia tiene su propia
 * memoria, asi que un contador local no limita nada. La DB es el unico estado
 * compartido entre instancias.
 */

export type AttemptRecord = {
  count: number;
  /** Inicio de la ventana actual, en ms epoch. */
  windowStart: number;
};

export type AttemptStore = {
  get(key: string): Promise<AttemptRecord | null>;
  set(key: string, record: AttemptRecord): Promise<void>;
  clear(key: string): Promise<void>;
};

export type ThrottleOptions = {
  /** Fallos permitidos por ventana. */
  maxAttempts?: number;
  /** Tamano de la ventana en ms. */
  windowMs?: number;
};

export type ThrottleResult =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

const DEFAULTS: Required<ThrottleOptions> = {
  maxAttempts: 10,
  windowMs: 15 * 60 * 1000,
};

/**
 * Llamar ANTES de verificar la contrasena. Si la ventana esta agotada,
 * devuelve cuanto falta para reintentar y el caller responde 429 sin gastar
 * CPU en scrypt.
 */
export async function checkThrottle(
  store: AttemptStore,
  key: string,
  options: ThrottleOptions = {},
): Promise<ThrottleResult> {
  const { maxAttempts, windowMs } = { ...DEFAULTS, ...options };
  const now = Date.now();
  const record = await store.get(key);

  if (!record || now - record.windowStart >= windowMs) return { allowed: true };
  if (record.count < maxAttempts) return { allowed: true };

  return {
    allowed: false,
    retryAfterSeconds: Math.max(
      1,
      Math.ceil((record.windowStart + windowMs - now) / 1000),
    ),
  };
}

/** Llamar tras un intento FALLIDO. */
export async function recordFailure(
  store: AttemptStore,
  key: string,
  options: ThrottleOptions = {},
): Promise<void> {
  const { windowMs } = { ...DEFAULTS, ...options };
  const now = Date.now();
  const record = await store.get(key);

  if (!record || now - record.windowStart >= windowMs) {
    await store.set(key, { count: 1, windowStart: now });
    return;
  }
  await store.set(key, { count: record.count + 1, windowStart: record.windowStart });
}

/** Llamar tras un login CORRECTO, para no penalizar al dueno legitimo. */
export async function recordSuccess(
  store: AttemptStore,
  key: string,
): Promise<void> {
  await store.clear(key);
}

/**
 * Clave de throttle a partir de la peticion. La IP de cliente en Vercel es el
 * primer valor de x-forwarded-for. Sin header (dev local), una clave fija.
 */
export function throttleKeyFromRequest(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  const ip = fwd?.split(",")[0]?.trim();
  return `login:${ip || "local"}`;
}
