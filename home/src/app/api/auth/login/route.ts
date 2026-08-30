import { z } from "zod";
import {
  checkThrottle,
  recordFailure,
  recordSuccess,
  throttleKeyFromRequest,
} from "@vault/auth/throttle";
import { login } from "@/lib/auth";
import { attemptStore } from "@/lib/attempt-store";

export const runtime = "nodejs";

const schema = z.object({ password: z.string().min(1) });

export async function POST(req: Request) {
  try {
    const key = throttleKeyFromRequest(req);

    // Rate limit antes de tocar scrypt: 10 fallos por IP cada 15 minutos.
    const throttle = await checkThrottle(attemptStore, key);
    if (!throttle.allowed) {
      return Response.json(
        {
          error: `Demasiados intentos. Espera ${Math.ceil(throttle.retryAfterSeconds / 60)} minutos.`,
        },
        {
          status: 429,
          headers: { "Retry-After": String(throttle.retryAfterSeconds) },
        },
      );
    }

    const body = schema.parse(await req.json());
    const okLogin = await login(body.password);

    if (!okLogin) {
      await recordFailure(attemptStore, key);
      // Retardo fijo para no filtrar informacion por tiempo de respuesta.
      await new Promise((r) => setTimeout(r, 400));
      return Response.json({ error: "Contrasena incorrecta" }, { status: 401 });
    }

    await recordSuccess(attemptStore, key);
    return Response.json({ ok: true });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Error desconocido";
    console.error("[portal login]", message);
    return Response.json({ error: message }, { status: 500 });
  }
}
