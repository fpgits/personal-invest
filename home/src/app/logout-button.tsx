"use client";

import { useRouter } from "next/navigation";
import { LogOut } from "lucide-react";

export function LogoutButton() {
  const router = useRouter();

  async function signOut() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.replace("/login");
    router.refresh();
  }

  return (
    <button
      onClick={signOut}
      className="flex items-center gap-2 rounded-lg border border-border px-3 py-1.5 text-sm text-muted transition hover:border-border-strong hover:text-text"
    >
      <LogOut size={14} />
      Salir
    </button>
  );
}
