import { Card } from "@/components/ui";

/**
 * Esqueleto mientras carga cualquier pagina de la seccion. Ademas de dar
 * respuesta inmediata al navegar, hace que el prefetch de los enlaces del
 * menu se quede en este limite en vez de renderizar cada pagina entera.
 */
export default function Loading() {
  return (
    <div aria-busy="true" aria-label="Cargando">
      <div className="mb-6 h-8 w-40 rounded-lg bg-surface pulse-soft" />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card className="pulse-soft h-28" />
        <Card className="pulse-soft h-28" />
        <Card className="pulse-soft h-28" />
        <Card className="pulse-soft h-28" />
      </div>
      <Card className="pulse-soft mt-4 h-72" />
    </div>
  );
}
