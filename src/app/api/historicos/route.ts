import { z } from "zod";
import { parseBody, protectedRoute } from "@/lib/api";
import { episodeRows, listEpisodes, scanSymbols } from "@/lib/historicos";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Recorre EDGAR y Stooq símbolo a símbolo: lento a propósito.
export const maxDuration = 300;

/** Episodios guardados (grandes subidas y máximos) con su foto de seis meses antes. */
export const GET = protectedRoute(async () => {
  const episodes = await listEpisodes(300);
  return Response.json({ episodes, rows: episodeRows(episodes), asOf: Date.now() });
});

const schema = z.object({
  /** Sin símbolos: todos los activos seguidos (cartera y watchlist). */
  symbols: z.array(z.string().min(1).max(12)).max(40).optional(),
});

/** Recalcula los episodios (botón, no cron). */
export const POST = protectedRoute(async (req) => {
  const { symbols } = await parseBody(req, schema);
  const results = await scanSymbols(symbols);
  return Response.json({ results, asOf: Date.now() });
});
