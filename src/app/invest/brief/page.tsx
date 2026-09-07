import { BriefCard } from "@/components/brief-card";
import { PageTitle } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * "Qué hacer": la versión para humanos. Esta semana (vender, reducir,
 * revisar), este mes (a dónde va el aporte) y qué vigilar. Todo lo demás de
 * la app existe para sostener esta página.
 */
export default function BriefPage() {
  return (
    <>
      <PageTitle subtitle="Esta semana y este mes, en lenguaje llano. Sin jerga: compra, vende, espera.">
        Qué hacer
      </PageTitle>
      <BriefCard />
    </>
  );
}
