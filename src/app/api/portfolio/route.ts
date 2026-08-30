import { protectedRoute } from "@/lib/api";
import { computePortfolio } from "@/lib/portfolio";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = protectedRoute(async () => {
  const portfolio = await computePortfolio();
  return Response.json(portfolio);
});
