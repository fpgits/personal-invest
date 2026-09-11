import { PageTitle } from "@/components/ui";
import { PoweroPanel } from "./powero-panel";

export const dynamic = "force-dynamic";

/**
 * PoWERo: el libro nocional. Toma las señales que el motor ya produce, las
 * dimensiona contra un capital que pones tú, las apunta con precio y hora, y
 * las valora a mercado. De ahí sale la curva que dice si el oráculo acierta.
 *
 * No coloca órdenes. Nunca. Ni cuando gane autonomía: lo que puede ganarse es
 * proponer sin preguntar, no comprar.
 */
export default function PoweroPage() {
  return (
    <>
      <PageTitle subtitle="Libro nocional con tus señales y precios reales. Propone; tú decides. No opera.">
        PoWERo
      </PageTitle>
      <PoweroPanel />
    </>
  );
}
