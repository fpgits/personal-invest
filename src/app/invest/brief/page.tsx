import { BriefCard } from "@/components/brief-card";
import { PageTitle } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * "Que hacer": la version para humanos. Esta semana (vender, reducir,
 * revisar), este mes (a donde va el aporte) y que vigilar. Todo lo demas de
 * la app existe para sostener esta pagina.
 */
export default function BriefPage() {
  return (
    <>
      <PageTitle subtitle="Esta semana y este mes, en lenguaje llano. Sin jerga: compra, vende, espera.">
        Que hacer
      </PageTitle>
      <BriefCard />
    </>
  );
}
