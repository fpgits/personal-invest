import type { ReactNode } from "react";
import { Nav } from "@/components/nav";
import { GroupProvider } from "@/components/group-picker";
import { PeriodProvider } from "@/components/period-picker";
import { readGroup } from "@/lib/group-server";
import { readPeriod } from "@/lib/period-server";
import { todayUtc } from "@/lib/period";

export default async function AppLayout({ children }: { children: ReactNode }) {
  // El periodo de revision y el grupo de activos son globales a la seccion:
  // se leen de la cookie aqui y las paginas de cliente los reciben por contexto.
  const [{ spec }, group] = await Promise.all([readPeriod(), readGroup()]);
  return (
    <PeriodProvider initial={spec} serverToday={todayUtc()}>
      <GroupProvider initial={group}>
        <div className="min-h-screen">
          <Nav />
          <main className="px-4 py-6 md:ml-60 md:px-8 md:py-8">
            <div className="mx-auto max-w-6xl">{children}</div>
          </main>
        </div>
      </GroupProvider>
    </PeriodProvider>
  );
}
