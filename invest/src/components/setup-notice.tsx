import { AlertTriangle } from "lucide-react";
import type { SetupCheck } from "@/lib/setup";
import { Card } from "./ui";

export function SetupNotice({ missing }: { missing: SetupCheck[] }) {
  if (missing.length === 0) return null;

  return (
    <Card className="border-warn/30 bg-warn/5">
      <div className="flex gap-3">
        <AlertTriangle size={18} className="mt-0.5 shrink-0 text-warn" />
        <div className="min-w-0">
          <p className="font-medium">Falta configuracion</p>
          <p className="mt-1 text-sm text-muted">
            Anade estas variables en Vercel (Settings, Environment Variables) o
            en tu .env.local y vuelve a desplegar.
          </p>
          <ul className="mt-3 space-y-1.5">
            {missing.map((c) => (
              <li key={c.key} className="text-sm">
                <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-xs text-warn">
                  {c.key}
                </code>
                <span className="ml-2 text-faint">{c.hint}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Card>
  );
}
