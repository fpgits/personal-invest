import { streamText, type ModelMessage } from "ai";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { aiMessages, aiThreads } from "@/db/schema";
import { errorResponse, parseBody } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { analysisModel } from "@/lib/ai/client";
import { buildFullContext } from "@/lib/ai/context";
import { CHAT_SYSTEM } from "@/lib/ai/prompts";
import { resolveModels } from "@/lib/settings";
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

    // Historial reciente para dar continuidad sin inflar el prompt.
    const history = await db
      .select()
      .from(aiMessages)
      .where(eq(aiMessages.threadId, thread))
      .orderBy(desc(aiMessages.createdAt))
      .limit(20);

    const context = await buildFullContext();
    const { analysis } = await resolveModels();

    const messages: ModelMessage[] = [
      {
        role: "system",
        content: `${CHAT_SYSTEM}\n\n# Contexto actual\n\n${context}`,
      },
      ...history
        .reverse()
        .map((m) => ({
          role: m.role === "assistant" ? ("assistant" as const) : ("user" as const),
          content: m.content,
        })),
      { role: "user", content: message },
    ];

    await db.insert(aiMessages).values({
      id: id(),
      threadId: thread,
      role: "user",
      content: message,
      createdAt: Date.now(),
    });

    const result = streamText({
      model: await analysisModel(),
      messages,
      temperature: 0.4,
      onFinish: async ({ text }) => {
        await db.insert(aiMessages).values({
          id: id(),
          threadId: thread,
          role: "assistant",
          content: text,
          model: analysis,
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
      headers: { "x-thread-id": thread, "x-model": analysis },
    });
  } catch (e) {
    return errorResponse(e);
  }
}
