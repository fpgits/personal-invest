import type { ReactNode } from "react";
import { cn, fmtMoney, fmtPct } from "@/lib/utils";

export function Card({
  children,
  className,
  padded = true,
}: {
  /** Opcional para poder usar Card vacia como esqueleto de carga. */
  children?: ReactNode;
  className?: string;
  padded?: boolean;
}) {
  return (
    <div
      className={cn(
        "rounded-xl border border-border bg-surface",
        padded && "p-5",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function CardTitle({
  children,
  action,
}: {
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="mb-4 flex items-center justify-between gap-3">
      <h2 className="text-sm font-medium text-muted">{children}</h2>
      {action}
    </div>
  );
}

export function PageTitle({
  children,
  subtitle,
  action,
}: {
  children: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{children}</h1>
        {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

/** Cifra grande con su delta. El color lo decide el signo, no el llamador. */
export function Stat({
  label,
  value,
  delta,
  deltaPct,
  currency = "USD",
  hint,
  neutral = false,
}: {
  label: string;
  value: number;
  delta?: number;
  deltaPct?: number;
  currency?: string;
  hint?: string;
  neutral?: boolean;
}) {
  const dir = neutral ? 0 : Math.sign(delta ?? value);
  return (
    <Card>
      <p className="text-xs font-medium uppercase tracking-wide text-faint">
        {label}
      </p>
      <p
        className={cn(
          "tnum mt-2 text-2xl font-semibold",
          !neutral && dir > 0 && "text-up",
          !neutral && dir < 0 && "text-down",
        )}
      >
        {fmtMoney(value, currency)}
      </p>
      {(delta !== undefined || deltaPct !== undefined) && (
        <p
          className={cn(
            "tnum mt-1 text-sm",
            (delta ?? deltaPct ?? 0) > 0 && "text-up",
            (delta ?? deltaPct ?? 0) < 0 && "text-down",
            (delta ?? deltaPct ?? 0) === 0 && "text-muted",
          )}
        >
          {delta !== undefined && fmtMoney(delta, currency)}
          {delta !== undefined && deltaPct !== undefined && " · "}
          {deltaPct !== undefined && fmtPct(deltaPct)}
        </p>
      )}
      {hint && <p className="mt-1 text-xs text-faint">{hint}</p>}
    </Card>
  );
}

export function Delta({
  value,
  pct,
  currency = "USD",
  className,
}: {
  value?: number;
  pct?: number;
  currency?: string;
  className?: string;
}) {
  const n = value ?? pct ?? 0;
  return (
    <span
      className={cn(
        "tnum",
        n > 0 && "text-up",
        n < 0 && "text-down",
        n === 0 && "text-muted",
        className,
      )}
    >
      {value !== undefined && fmtMoney(value, currency)}
      {value !== undefined && pct !== undefined && " "}
      {pct !== undefined && (
        <span className={cn(value !== undefined && "text-xs opacity-80")}>
          ({fmtPct(pct)})
        </span>
      )}
    </span>
  );
}

const badgeTones = {
  neutral: "bg-surface-2 text-muted border-border",
  up: "bg-up-dim text-up border-up/25",
  down: "bg-down-dim text-down border-down/25",
  accent: "bg-accent-dim text-accent border-accent/25",
  warn: "bg-warn/10 text-warn border-warn/25",
} as const;

export function Badge({
  children,
  tone = "neutral",
  className,
}: {
  children: ReactNode;
  tone?: keyof typeof badgeTones;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md border px-1.5 py-0.5 text-[11px] font-medium",
        badgeTones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <Card className="flex flex-col items-center justify-center py-14 text-center">
      <p className="font-medium">{title}</p>
      {children && (
        <p className="mt-1 max-w-md text-sm text-muted">{children}</p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </Card>
  );
}

export function AssetIcon({
  symbol,
  logoUrl,
  size = 32,
}: {
  symbol: string;
  logoUrl?: string | null;
  size?: number;
}) {
  if (logoUrl) {
    return (
      // Logos de proveedores externos: <img> evita configurar cada host.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={logoUrl}
        alt=""
        width={size}
        height={size}
        className="shrink-0 rounded-full bg-surface-2 object-contain"
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-full bg-surface-2 text-[10px] font-semibold text-muted"
      style={{ width: size, height: size }}
    >
      {symbol.slice(0, 3)}
    </div>
  );
}

export function ClassBadge({ assetClass }: { assetClass: string }) {
  const label =
    assetClass === "crypto" ? "Cripto" : assetClass === "etf" ? "ETF" : "Bolsa";
  return (
    <Badge tone={assetClass === "crypto" ? "warn" : "accent"}>{label}</Badge>
  );
}
