"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import {
  Bell,
  Bot,
  Briefcase,
  LayoutDashboard,
  LogOut,
  Menu,
  Newspaper,
  Plug,
  Settings,
  Star,
  X,
} from "lucide-react";
import { api, cn } from "@/lib/utils";

const LINKS = [
  { href: "/invest", label: "Resumen", icon: LayoutDashboard },
  { href: "/invest/cartera", label: "Cartera", icon: Briefcase },
  { href: "/invest/watchlist", label: "Watchlist", icon: Star },
  { href: "/invest/alertas", label: "Alertas", icon: Bell },
  { href: "/invest/noticias", label: "Noticias", icon: Newspaper },
  { href: "/invest/analisis", label: "Analisis IA", icon: Bot },
  { href: "/invest/cuentas", label: "Cuentas", icon: Plug },
  { href: "/invest/ajustes", label: "Ajustes", icon: Settings },
];

export function Nav() {
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);

  async function signOut() {
    await fetch(api("/api/auth/logout"), { method: "POST" });
    router.replace("/login");
    router.refresh();
  }

  const items = LINKS.map(({ href, label, icon: Icon }) => {
    const active =
      href === "/invest" ? pathname === "/invest" : pathname.startsWith(href);
    return (
      <Link
        key={href}
        href={href}
        onClick={() => setOpen(false)}
        className={cn(
          "flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition",
          active
            ? "bg-surface-2 font-medium text-text"
            : "text-muted hover:bg-surface hover:text-text",
        )}
      >
        <Icon size={16} className={active ? "text-accent" : ""} />
        {label}
      </Link>
    );
  });

  return (
    <>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label="Menu"
        className="fixed left-4 top-4 z-50 rounded-lg border border-border bg-surface p-2 md:hidden"
      >
        {open ? <X size={16} /> : <Menu size={16} />}
      </button>

      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-40 flex w-60 flex-col border-r border-border bg-bg px-3 py-5 transition-transform md:translate-x-0",
          open ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div className="mb-7 px-3 pt-8 md:pt-0">
          <Link href="/" className="block transition hover:opacity-80">
            <p className="text-xs text-faint">Vault /</p>
            <p className="text-sm font-semibold tracking-tight">Invest</p>
          </Link>
        </div>

        <nav className="flex flex-1 flex-col gap-0.5">{items}</nav>

        <button
          onClick={signOut}
          className="mt-4 flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-faint transition hover:bg-surface hover:text-down"
        >
          <LogOut size={16} />
          Salir
        </button>
      </aside>

      {open && (
        <div
          className="fixed inset-0 z-30 bg-black/60 md:hidden"
          onClick={() => setOpen(false)}
        />
      )}
    </>
  );
}
