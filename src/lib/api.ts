import { ZodError, type ZodType } from "zod";
import { requireAuth } from "./auth";

export type Handler = (req: Request) => Promise<Response>;

/** Envuelve un handler: exige sesion y convierte excepciones en JSON limpio. */
export function protectedRoute(handler: Handler): Handler {
  return async (req) => {
    const unauthorized = await requireAuth();
    if (unauthorized) return unauthorized;
    try {
      return await handler(req);
    } catch (e) {
      return errorResponse(e);
    }
  };
}

export function errorResponse(e: unknown): Response {
  if (e instanceof ZodError) {
    return Response.json(
      { error: "Datos invalidos", issues: e.issues },
      { status: 400 },
    );
  }
  const message = e instanceof Error ? e.message : "Error desconocido";
  console.error("[api]", message);
  return Response.json({ error: message }, { status: 500 });
}

export async function parseBody<T>(req: Request, schema: ZodType<T>): Promise<T> {
  const json = await req.json().catch(() => {
    throw new Error("El cuerpo de la peticion no es JSON valido");
  });
  return schema.parse(json);
}

export function ok(data: unknown = { ok: true }) {
  return Response.json(data);
}
