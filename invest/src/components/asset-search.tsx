"use client";

import { useEffect, useRef, useState } from "react";
import { Search } from "lucide-react";
import type { SearchHit } from "@/lib/market/types";
import { AssetIcon, ClassBadge } from "./ui";

/** Buscador con debounce contra /api/search. Devuelve el activo elegido. */
export function AssetSearch({
  onPick,
  placeholder = "Busca AAPL, bitcoin, VOO...",
  autoFocus,
}: {
  onPick: (hit: SearchHit) => void;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  // El resultado visible se deriva de la query en vez de sincronizarse con un
  // setState dentro del efecto, que provoca renders en cascada.
  const tooShort = query.trim().length < 2;
  const visible = tooShort ? [] : results;

  useEffect(() => {
    if (query.trim().length < 2) return;
    const ctrl = new AbortController();
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`, {
          signal: ctrl.signal,
        });
        const data = await res.json();
        setResults(data.results ?? []);
        setOpen(true);
      } catch {
        // Peticion cancelada por una tecla nueva: no es un error real.
      } finally {
        setLoading(false);
      }
    }, 300);

    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [query]);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  return (
    <div ref={boxRef} className="relative">
      <Search
        size={15}
        className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint"
      />
      <input
        value={query}
        autoFocus={autoFocus}
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => visible.length > 0 && setOpen(true)}
        placeholder={placeholder}
        className="w-full rounded-lg border border-border bg-surface py-2.5 pl-9 pr-3 text-sm outline-none transition focus:border-accent"
      />

      {loading && (
        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-faint">
          ...
        </span>
      )}

      {open && visible.length > 0 && (
        <ul className="absolute z-20 mt-1.5 max-h-72 w-full overflow-auto rounded-lg border border-border-strong bg-surface-2 py-1 shadow-xl">
          {visible.map((r) => (
            <li key={`${r.assetClass}:${r.providerId}`}>
              <button
                type="button"
                onClick={() => {
                  onPick(r);
                  setQuery("");
                  setResults([]);
                  setOpen(false);
                }}
                className="flex w-full items-center gap-3 px-3 py-2 text-left transition hover:bg-surface"
              >
                <AssetIcon symbol={r.symbol} logoUrl={r.logoUrl} size={24} />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">{r.symbol}</span>
                  <span className="block truncate text-xs text-faint">
                    {r.name}
                  </span>
                </span>
                <ClassBadge assetClass={r.assetClass} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
