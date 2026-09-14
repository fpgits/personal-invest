import { isCronAuthorized } from "@/lib/auth";
import { sweepCrypto } from "@/lib/crypto-universe-run";
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
 * `?years=N` acorta el histórico de bolsa y `?top=N` el universo cripto,
 * para probar rápido.
 */
export async function GET(req: Request) {
  if (!isCronAuthorized(req)) {
    return Response.json({ error: "No autorizado" }, { status: 401 });
  }
  const params = new URL(req.url).searchParams;
  const years = Number(params.get("years"));
  try {
    const dryRun = params.get("dry") === "1";
    const top = Number(params.get("top"));
    // Los dos lados en la misma pasada, y cada uno con su propio fallo: si la
    // SEC no contesta, el universo cripto no tiene por que caerse con ella.
    const [bolsa, cripto] = await Promise.all([
      sweepMarket({
        dryRun,
        years: Number.isFinite(years) && years >= 1 && years <= 15 ? years : undefined,
      }).catch((e) => ({ error: e instanceof Error ? e.message : "fallo" })),
      sweepCrypto({
        dryRun,
        top: Number.isFinite(top) && top >= 1 && top <= 250 ? top : undefined,
      }).catch((e) => ({ error: e instanceof Error ? e.message : "fallo" })),
    ]);
    return Response.json({ bolsa, cripto });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "fallo" }, { status: 500 });
  }
}
