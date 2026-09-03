"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  useTransition,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { GROUP_COOKIE, GROUP_KEYS, GROUP_LABELS, type GroupKey } from "@/lib/group";
import { cn } from "@/lib/utils";

/**
 * Grupo de activos (Todo/Bolsa/Cripto), global a la seccion igual que el
 * periodo: el estado vive en un contexto (paginas de cliente) y en una cookie
 * (paginas de servidor). Cada cambio reescribe la cookie y refresca el arbol
 * de servidor.
 */

type Ctx = {
  group: GroupKey;
  /** true mientras el servidor vuelve a renderizar con el grupo nuevo. */
  pending: boolean;
  setGroup: (next: GroupKey) => void;
};

const GroupContext = createContext<Ctx | null>(null);

function writeCookie(group: GroupKey) {
  const secure = typeof location !== "undefined" && location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${GROUP_COOKIE}=${group}; path=/; max-age=${365 * 86400}; SameSite=Lax${secure}`;
}

export function GroupProvider({
  initial,
  children,
}: {
  initial: GroupKey;
  children: ReactNode;
}) {
  const router = useRouter();
  const [group, setGroupState] = useState<GroupKey>(initial);
  const [pending, startTransition] = useTransition();

  const setGroup = useCallback(
    (next: GroupKey) => {
      setGroupState(next);
      writeCookie(next);
      // Las paginas de servidor (Cartera) se vuelven a renderizar con la
      // cookie nueva; `pending` lo cuenta mientras tanto.
      startTransition(() => router.refresh());
    },
    [router],
  );

  const value = useMemo(() => ({ group, pending, setGroup }), [group, pending, setGroup]);
  return <GroupContext.Provider value={value}>{children}</GroupContext.Provider>;
}

export function useGroup(): Ctx {
  const ctx = useContext(GroupContext);
  if (!ctx) throw new Error("useGroup fuera de GroupProvider");
  return ctx;
}

/** Control segmentado, pensado para ir al lado del PeriodPicker. */
export function GroupPicker({ className }: { className?: string }) {
  const { group, pending, setGroup } = useGroup();
  return (
    <div
      className={cn("inline-flex items-center rounded-lg border border-border bg-surface p-1", className)}
      role="tablist"
      aria-label="Filtrar por grupo"
    >
      {pending && <Loader2 size={13} className="ml-1 mr-0.5 animate-spin text-accent" aria-hidden />}
      {GROUP_KEYS.map((g) => {
        const active = g === group;
        return (
          <button
            key={g}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => setGroup(g)}
            className={cn(
              "rounded-md px-2.5 py-1.5 text-sm font-medium transition whitespace-nowrap",
              active ? "bg-accent text-white" : "text-muted hover:bg-surface-2 hover:text-text",
            )}
          >
            {GROUP_LABELS[g]}
          </button>
        );
      })}
    </div>
  );
}
