import type { ReactNode } from "react";
import { Nav } from "@/components/nav";
import { PeriodProvider } from "@/components/period-picker";
import { readPeriod } from "@/lib/period-server";
import { todayUtc } from "@/lib/period";

export default async function AppLayout({ children }: { children: ReactNode }) {
  // El periodo de revision es global a la seccion: lo lee de la cookie aqui
  // y las paginas de cliente lo reciben por contexto.
  const { spec } = await readPeriod();
  return (
    <PeriodProvider initial={spec} serverToday={todayUtc()}>
      <div className="min-h-screen">
        <Nav />
        <main className="px-4 py-6 md:ml-60 md:px-8 md:py-8">
          <div className="mx-auto max-w-6xl">{children}</div>
        </main>
      </div>
    </PeriodProvider>
  );
}
