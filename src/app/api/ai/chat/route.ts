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
  threadId: z.string().optional(),
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

    const messages: ModelMessage[] = [
      {
        role: "system",
        content: `${CHAT_SYSTEM}\n\n# Contexto actual\n\n${context}`,
        // El contexto es identico entre mensajes del mismo rato: los
        // proveedores con cache de prompt (Anthropic explicita; Gemini,
        // OpenAI y DeepSeek automatica) lo cobran a fraccion de precio.
        providerOptions: { openrouter: { cacheControl: { type: "ephemeral" } } },
      },
      ...history,
      { role: "user", content: message },
    ];

    await db.insert(aiMessages).values({
      id: id(),
      threadId: thread,
      role: "user",
      content: message,
      createdAt: Date.now(),
    });

    const { result, modelId } = await aiStream("chat", {
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
