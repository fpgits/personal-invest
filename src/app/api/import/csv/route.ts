import { db } from "@/db";
import { transactions } from "@/db/schema";
import { protectedRoute } from "@/lib/api";
import { ensureAsset } from "@/lib/assets";
import { parseTransactionsCsv } from "@/lib/csv";
import { id } from "@/lib/utils";
import { defaultAccountId } from "../../transactions/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Acepta el CSV en crudo. Con `?dryRun=1` solo devuelve lo que haria,
 * para que la UI muestre una vista previa antes de escribir nada.
 */
export const POST = protectedRoute(async (req) => {
  const dryRun = new URL(req.url).searchParams.get("dryRun") === "1";
  const content = await req.text();
  if (!content.trim()) {
    return Response.json({ error: "El archivo esta vacio" }, { status: 400 });
  }

  const report = parseTransactionsCsv(content);
  if (report.rows.length === 0) {
    return Response.json(
      { error: "No se pudo leer ninguna fila", ...report },
      { status: 400 },
    );
  }

  if (dryRun) {
    return Response.json({
      dryRun: true,
      willImport: report.rows.length,
      errors: report.errors,
      detectedColumns: report.detectedColumns,
      preview: report.rows.slice(0, 20),
    });
  }

  const accountId = await defaultAccountId();
  let imported = 0;

  for (const row of report.rows) {
    const asset = await ensureAsset({
      symbol: row.symbol,
      assetClass: row.assetClass,
    });
    await db.insert(transactions).values({
      id: id(),
      accountId,
      assetId: asset.id,
      type: row.type,
      quantity: row.quantity,
      price: row.price,
      fee: row.fee,
      currency: row.currency,
      executedAt: row.executedAt,
      // Clave estable para que reimportar el mismo CSV no duplique.
      externalId: `csv:${row.symbol}:${row.type}:${row.executedAt}:${row.quantity}:${row.price}`,
      source: "csv",
      note: row.note ?? null,
      createdAt: Date.now(),
    }).onConflictDoNothing();
    imported++;
  }

  return Response.json({
    imported,
    errors: report.errors,
    detectedColumns: report.detectedColumns,
  });
});
