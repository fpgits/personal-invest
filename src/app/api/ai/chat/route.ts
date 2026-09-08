import { type ModelMessage } from "ai";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { aiMessages, aiThreads } from "@/db/schema";
import { errorResponse, parseBody } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { aiStream } from "@/lib/ai/client";
import { cachedFullContext } from "@/lib/ai/context";
import { CHAT_LIMITS, trimHistory } from "@/lib/ai/policy";
import { CHAT_SYSTEM } from "@/lib/ai/prompts";
import { id } from "@/lib/utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const schema = z.object({
  message: z.string().min(1).max(8000),
  // `nullish`, no `optional`: el cliente abre el hilo con threadId = null y
  // JSON.stringify manda `null`, no omite la clave. Con `.optional()` zod lo
  // rechazaba, asi que el PRIMER mensaje de cada hilo moria en un 400 y el
  // chat no llegaba a funcionar nunca.
  threadId: z.string().min(1).nullish(),
});

export async function POST(req: Request) {
  const unauthorized = await requireAuth();
  if (unauthorized) return unauthorized;

  try {
    const { message, threadId } = await parseBody(req, schema);

    let thread = threadId;
    if (!thread) {
      thread = id();
      await db.insert(aiThreads).values({
        id: thread,
        title: message.slice(0, 60),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }

    // Historial reciente para dar continuidad, acotado en mensajes y en
    // caracteres: un hilo largo no puede convertir cada pregunta en un
    // prompt de decenas de miles de tokens.
    const [rows, context] = await Promise.all([
      db
        .select({ role: aiMessages.role, content: aiMessages.content })
        .from(aiMessages)
        .where(eq(aiMessages.threadId, thread))
        .orderBy(desc(aiMessages.createdAt))
        .limit(CHAT_LIMITS.historyMessages),
      cachedFullContext(),
    ]);
    const history = trimHistory(
      rows.reverse().map((m) => ({
        role: m.role === "assistant" ? ("assistant" as const) : ("user" as const),
        content: m.content,
      })),
    );

    // Las instrucciones van en `system`, NO como un mensaje: el AI SDK v7
    // rechaza un role "system" dentro de messages y el fallo sale como una
    // respuesta vacia (200 sin texto), que parece que el chat se cuelga.
    // El contexto es identico entre mensajes del mismo rato, asi que los
    // proveedores con cache de prompt lo cobran a fraccion de precio.
    const system = `${CHAT_SYSTEM}\n\n# Contexto actual\n\n${context}`;
    const messages: ModelMessage[] = [...history, { role: "user", content: message }];

    await db.insert(aiMessages).values({
      id: id(),
      threadId: thread,
      role: "user",
      content: message,
      createdAt: Date.now(),
    });

    const { result, modelId } = await aiStream("chat", {
      system,
      messages,
      temperature: 0.4,
      onFinish: async (text) => {
        await db.insert(aiMessages).values({
          id: id(),
          threadId: thread,
          role: "assistant",
          content: text,
          model: modelId,
          createdAt: Date.now(),
        });
        await db
          .update(aiThreads)
          .set({ updatedAt: Date.now() })
          .where(eq(aiThreads.id, thread));
      },
    });

    /*
     * Consume el stream en el servidor aunque el cliente corte la conexion:
     * sin esto, cerrar la pestana a mitad de respuesta aborta onFinish y el
     * mensaje del asistente no se guarda en el hilo.
     */
    result.consumeStream();

    return result.toTextStreamResponse({
      headers: { "x-thread-id": thread, "x-model": modelId },
    });
  } catch (e) {
    return errorResponse(e);
  }
}
