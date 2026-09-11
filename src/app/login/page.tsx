"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { ArrowRight, Eye, EyeOff } from "lucide-react";
import { ThemeToggle } from "@/components/theme-toggle";
import { cn } from "@/lib/utils";

/**
 * La puerta. Aquí el lenguaje visual es otro a propósito: dentro la app es una
 * rejilla densa de cifras en monoespaciada, y eso está bien para trabajar;
 * una puerta pide aire, tipografía humanista y una sola cosa que hacer.
 *
 * Usa las mismas variables de color, así que el tema claro y el oscuro
 * funcionan igual aquí que dentro.
 */

/** Lo que hay detrás de la puerta. Es cierto: son las secciones que existen. */
const SECCIONES = [
  ["Qué hacer", "Qué comprar y qué vender, sin jerga"],
  ["PoWERo", "Mide si el oráculo acierta, sin dinero real"],
  ["Cartera", "Tus posiciones de IBKR y Binance"],
  ["Análisis", "Veredicto fundamental, sin IA"],
] as const;

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? "No se pudo entrar");
        setBusy(false);
        return;
      }
      const next = params.get("next");
      // Solo rutas internas: nada de redirigir fuera del vault.
      router.replace(next && next.startsWith("/") ? next : "/");
      router.refresh();
    } catch {
      setError("Error de red");
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col p-8 sm:p-10">
      <h1 className="text-2xl font-semibold tracking-tight">Entrar</h1>

      <label className="mt-7 block text-sm font-medium text-muted" htmlFor="password">
        Contraseña
      </label>
      <div className="relative mt-2">
        <input
          id="password"
          type={show ? "text" : "password"}
          autoFocus
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className={cn(
            "w-full rounded-lg border bg-surface px-3.5 py-3 pr-12 text-sm outline-none transition",
            error ? "border-down" : "border-border-strong focus:border-text",
          )}
        />
        <button
          type="button"
          onClick={() => setShow((v) => !v)}
          aria-label={show ? "Ocultar contraseña" : "Mostrar contraseña"}
          className="absolute inset-y-0 right-0 flex w-11 items-center justify-center text-faint transition hover:text-text"
        >
          {show ? <EyeOff size={16} /> : <Eye size={16} />}
        </button>
      </div>

      {error ? (
        <p className="mt-2 text-sm text-down">{error}</p>
      ) : (
        <p className="mt-2 text-xs text-faint">Una sola llave para todo lo que hay dentro.</p>
      )}

      <button
        type="submit"
        disabled={busy || password.length === 0}
        className="mt-6 flex w-full items-center justify-center gap-2 rounded-full bg-accent px-4 py-3 text-sm font-medium text-bg transition hover:opacity-90 disabled:opacity-20"
      >
        {busy ? "Entrando…" : "Entrar"}
        {!busy && <ArrowRight size={15} />}
      </button>

      {/* Empuja la nota al pie de la columna: así las dos mitades acaban a la
          misma altura en vez de dejar un hueco en medio. */}
      <p className="mt-auto pt-8 text-xs leading-relaxed text-faint">
        Esta plataforma es de <b className="font-medium text-muted">solo lectura</b>: mira tus cuentas,
        analiza y avisa. Nunca coloca una orden ni mueve un dólar.
      </p>
    </form>
  );
}

export default function LoginPage() {
  return (
    <main className="font-ui relative flex min-h-screen flex-col bg-canvas">
      <header className="flex items-center justify-between px-6 py-5 sm:px-10">
        <div className="flex h-9 w-9 items-center justify-center rounded-full border border-border-strong text-[11px] font-semibold tracking-tight">
          FP
        </div>
        <ThemeToggle />
      </header>

      {/* La tarjeta se centra en lo que queda de alto, no en la pagina entera:
          asi no se va al fondo ni deja un vacio debajo. */}
      <div className="flex flex-1 items-center justify-center px-4 pb-14">
        <div className="grid w-full max-w-3xl overflow-hidden rounded-2xl border border-border bg-surface shadow-[0_1px_3px_rgba(0,0,0,0.05)] md:grid-cols-[1fr_0.8fr]">
          <Suspense>
            <LoginForm />
          </Suspense>

          <aside className="hidden border-l border-border bg-surface-2 p-10 md:block">
            <h2 className="text-base font-semibold tracking-tight">Fernando Portela</h2>
            <p className="mt-1.5 text-sm leading-relaxed text-muted">
              Todo en un sitio: las inversiones, qué hacer con ellas, y por qué.
            </p>

            <ul className="mt-7 space-y-4">
              {SECCIONES.map(([titulo, que]) => (
                <li key={titulo}>
                  <div className="text-sm font-medium">{titulo}</div>
                  <div className="mt-0.5 text-xs leading-relaxed text-faint">{que}</div>
                </li>
              ))}
            </ul>
          </aside>
        </div>
      </div>
    </main>
  );
}
