import Link from "next/link";
import { ArrowUpRight, LineChart, Plus } from "lucide-react";
import { LogoutButton } from "./logout-button";

export const dynamic = "force-dynamic";

/**
 * Home del vault: una tarjeta por modulo. La guarda de sesion vive en el
 * proxy; si esta pagina se renderiza, ya hay sesion valida.
 */

const MODULES = [
  {
    href: "/invest",
    name: "Invest",
    description:
      "Cartera con P&L, watchlist, analisis con IA y noticias. IBKR y Binance sincronizados.",
    icon: LineChart,
    accent: "#5b8def",
  },
];

export default function VaultHome() {
  return (
    <main className="mx-auto max-w-4xl px-5 py-12 md:py-16">
      <header className="mb-10 flex items-end justify-between gap-4">
        <div>
          <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-faint">
            vault
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">
            Todo en un sitio
          </h1>
        </div>
        <LogoutButton />
      </header>

      <div className="grid gap-4 sm:grid-cols-2">
        {MODULES.map((m) => (
          <Link
            key={m.href}
            href={m.href}
            className="fade-up group rounded-xl border border-border bg-surface p-5 transition hover:border-border-strong hover:bg-surface-2"
          >
            <div className="flex items-start justify-between">
              <span
                className="flex h-10 w-10 items-center justify-center rounded-lg"
                style={{ background: `${m.accent}1f`, color: m.accent }}
              >
                <m.icon size={18} />
              </span>
              <ArrowUpRight
                size={16}
                className="text-faint opacity-0 transition group-hover:opacity-100"
              />
            </div>
            <h2 className="mt-4 font-semibold">{m.name}</h2>
            <p className="mt-1 text-sm leading-relaxed text-muted">
              {m.description}
            </p>
          </Link>
        ))}

        <div className="flex min-h-40 flex-col items-center justify-center rounded-xl border border-dashed border-border p-5 text-center">
          <Plus size={18} className="text-faint" />
          <p className="mt-2 text-sm text-faint">Siguiente modulo</p>
        </div>
      </div>
    </main>
  );
}
