import { z } from "zod";
import { login } from "@/lib/auth";
import { errorResponse, parseBody } from "@/lib/api";

export const runtime = "nodejs";

const schema = z.object({ password: z.string().min(1) });

export async function POST(req: Request) {
  try {
    const { password } = await parseBody(req, schema);
    const okLogin = await login(password);
    if (!okLogin) {
      // Retardo fijo para no filtrar informacion por tiempo de respuesta.
      await new Promise((r) => setTimeout(r, 400));
      return Response.json({ error: "Contrasena incorrecta" }, { status: 401 });
    }
    return Response.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
