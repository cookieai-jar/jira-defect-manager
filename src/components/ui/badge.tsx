import * as React from "react";
import { cn } from "@/lib/utils";
import type { TemperatureBand } from "@/types/triage";

export function Badge({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border border-border-strong bg-bg-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-fg-muted",
        className,
      )}
      {...props}
    />
  );
}

const TEMP_STYLES: Record<TemperatureBand, string> = {
  cold: "border-temperature-cold/40 bg-temperature-cold/10 text-temperature-cold",
  cool: "border-temperature-cool/40 bg-temperature-cool/10 text-temperature-cool",
  warm: "border-temperature-warm/40 bg-temperature-warm/10 text-temperature-warm",
  hot: "border-temperature-hot/40 bg-temperature-hot/10 text-temperature-hot",
  critical: "border-temperature-critical/40 bg-temperature-critical/15 text-temperature-critical",
};

export function TempBadge({ band, score }: { band: TemperatureBand; score: number }) {
  return (
    <Badge className={cn(TEMP_STYLES[band], "border")}>
      <span className="inline-block h-1.5 w-1.5 rounded-full bg-current" />
      {band} · {score}
    </Badge>
  );
}

const HEALTH_STYLES: Record<"green" | "yellow" | "red", string> = {
  green: "border-success/40 bg-success/10 text-success",
  yellow: "border-warning/40 bg-warning/10 text-warning",
  red: "border-danger/40 bg-danger/10 text-danger",
};

export function HealthBadge({ health }: { health: "green" | "yellow" | "red" }) {
  return (
    <Badge className={cn(HEALTH_STYLES[health], "border")}>
      <span className="inline-block h-1.5 w-1.5 rounded-full bg-current" />
      {health}
    </Badge>
  );
}
