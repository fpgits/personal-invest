"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { LockKeyhole } from "lucide-react";

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [password, setPassword] = useState("");
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
    <form onSubmit={submit} className="w-full max-w-sm">
      <div className="mb-8 text-center">
        <div className="mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-xl border border-border bg-surface">
          <LockKeyhole size={18} className="text-accent" />
        </div>
        <h1 className="text-xl font-semibold">Vault</h1>
        <p className="mt-1 text-sm text-muted">Tu espacio. Una sola llave.</p>
      </div>

      <label className="mb-2 block text-sm text-muted" htmlFor="password">
        Contrasena
      </label>
      <input
        id="password"
        type="password"
        autoFocus
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        className="w-full rounded-lg border border-border bg-surface px-3 py-2.5 text-sm outline-none transition focus:border-accent"
      />

      {error && <p className="mt-3 text-sm text-warn">{error}</p>}

      <button
        type="submit"
        disabled={busy || password.length === 0}
        className="mt-5 w-full rounded-lg bg-accent px-3 py-2.5 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-40"
      >
        {busy ? "Entrando..." : "Entrar"}
      </button>
    </form>
  );
}

export default function LoginPage() {
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <Suspense>
        <LoginForm />
      </Suspense>
    </main>
  );
}
