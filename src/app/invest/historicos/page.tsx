import { PageTitle } from "@/components/ui";
import { HistoricosPanel } from "./historicos-panel";

export const dynamic = "force-dynamic";

/**
 * Históricos: memoria de patrones. Qué se podía ver seis meses antes de cada
 * gran subida y cada máximo histórico, con los datos que entonces eran
 * públicos. De aquí sale la calibración de los detectores.
 */
export default function HistoricosPage() {
  return (
    <>
      <PageTitle subtitle="Grandes subidas y máximos del pasado, y qué había en los fundamentales seis meses antes.">
        Históricos
      </PageTitle>
      <HistoricosPanel />
    </>
  );
}
