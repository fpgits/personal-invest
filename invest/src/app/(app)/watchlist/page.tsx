"use client";

import useSWR from "swr";
import { useState } from "react";
import { Trash2 } from "lucide-react";
import { AssetSearch } from "@/components/asset-search";
import {
  AssetIcon,
  Card,
  ClassBadge,
  Delta,
  EmptyState,
  PageTitle,
} from "@/components/ui";
import type { Asset } from "@/db/schema";
import type { SearchHit } from "@/lib/market/types";
import { api, fmtMoney } from "@/lib/utils";

type Item = {
  entry: { id: string; assetId: string; note: string | null };
  asset: Asset;
  quote: {
    price: number;
    change: number;
    changePct: number;
    currency: string;
    stale: boolean;
  } | null;
};

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export default function WatchlistPage() {
  const { data, mutate, isLoading } = useSWR<{ items: Item[] }>(api("/api/watchlist"),
    fetcher,
    { refreshInterval: 60_000 },
  );
  const [busy, setBusy] = useState(false);

  async function add(hit: SearchHit) {
    setBusy(true);
    await fetch(api("/api/watchlist"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        symbol: hit.symbol,
        assetClass: hit.assetClass,
        providerId: hit.providerId,
        name: hit.name,
      }),
    });
    setBusy(false);
    mutate();
  }

  async function remove(assetId: string) {
    await fetch(api(`/api/watchlist?assetId=${encodeURIComponent(assetId)}`), {
      method: "DELETE",
    });
    mutate();
  }

  const items = data?.items ?? [];

  return (
    <>
      <PageTitle subtitle="Lo que sigues sin tenerlo todavia">
        Watchlist
      </PageTitle>

      <div className="mb-4 max-w-md">
        <AssetSearch onPick={add} placeholder="Anadir un activo a seguir..." />
      </div>

      {isLoading ? (
        <Card className="pulse-soft h-40" />
      ) : items.length === 0 ? (
        <EmptyState title="La watchlist esta vacia">
          Busca arriba cualquier accion, ETF o cripto y quedara aqui con su
          precio, actualizado cada minuto.
        </EmptyState>
      ) : (
        <Card padded={false} className={busy ? "opacity-60" : undefined}>
          <ul className="divide-y divide-border">
            {items.map(({ entry, asset, quote }) => (
              <li
                key={entry.id}
                className="group flex items-center gap-3 px-5 py-3 transition hover:bg-surface-2"
              >
                <AssetIcon
                  symbol={asset.symbol}
                  logoUrl={asset.logoUrl}
                  size={30}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{asset.symbol}</span>
                    <ClassBadge assetClass={asset.assetClass} />
                  </div>
                  <p className="truncate text-xs text-faint">{asset.name}</p>
                </div>

                <div className="text-right">
                  <p className="tnum text-sm font-medium">
                    {quote ? fmtMoney(quote.price, quote.currency) : "—"}
                  </p>
                  {quote && (
                    <Delta pct={quote.changePct} className="text-xs" />
                  )}
                </div>

                <button
                  onClick={() => remove(asset.id)}
                  aria-label={`Quitar ${asset.symbol}`}
                  className="ml-2 text-faint opacity-0 transition group-hover:opacity-100 hover:text-down"
                >
                  <Trash2 size={15} />
                </button>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}
