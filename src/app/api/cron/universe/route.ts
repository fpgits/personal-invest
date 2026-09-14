import { isCronAuthorized } from "@/lib/auth";
import { sweepMarket } from "@/lib/universe-run";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// 144 peticiones a 8/s son ~18 s; el resto es armar y escribir miles de filas.
export const maxDuration = 300;

/**
 * El barrido del mercado. Una vez al dia basta: los frames de la SEC se
 * recompilan por la noche y los fundamentales cambian por trimestres.
 *
 * `?dry=1` cuenta sin escribir. La PRIMERA pasada conviene hacerla asi: lo
 * que hay que saber antes de llenar nada es cuantas de las ~6.000 empresas
 * quedan valorables. Si son 4.000, hay buscador de mercado; si son 800, hay
 * que arreglar el lector antes de rankear nada, porque un ranking construido
 * sobre las que sobrevivieron al parser no dice lo que parece decir.
 *
 * `?years=N` acorta el histórico para probar rápido.
 */
export async function GET(req: Request) {
  if (!isCronAuthorized(req)) {
    return Response.json({ error: "No autorizado" }, { status: 401 });
  }
  const params = new URL(req.url).searchParams;
  const years = Number(params.get("years"));
  try {
    const result = await sweepMarket({
      dryRun: params.get("dry") === "1",
      years: Number.isFinite(years) && years >= 1 && years <= 15 ? years : undefined,
    });
    return Response.json(result);
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "fallo" }, { status: 500 });
  }
}
