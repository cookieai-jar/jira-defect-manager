"use client";

import { useState } from "react";
import type { GroupTrend } from "@/lib/defect-trends-core";

const W = 280;
const H = 120;
const PAD = 4;

/** Default multi-series palette (used when a series has no explicit color). */
const PALETTE = [
  "hsl(220 90% 60%)",
  "hsl(142 70% 45%)",
  "hsl(38 92% 55%)",
  "hsl(0 80% 62%)",
  "hsl(280 65% 65%)",
  "hsl(190 75% 50%)",
];

/**
 * Compact multi-series sparkline for a tile. Renders the given series over the
 * trend's days, restricted to `keys` (defaults to all). `colors` maps a series
 * key to a stroke color; otherwise the palette is used.
 */
export function MiniTrend({
  trend,
  keys,
  colors,
  yLabel = "Tickets",
  xLabel = "Date",
}: {
  trend: GroupTrend | undefined;
  keys?: string[];
  colors?: Record<string, string>;
  /** Y-axis title (what the count measures). */
  yLabel?: string;
  /** X-axis title. */
  xLabel?: string;
}) {
  const [hover, setHover] = useState<number | null>(null);

  if (!trend || trend.days.length < 2) {
    return (
      <p className="text-[10px] text-fg-subtle mt-2">
        Trend builds over time — {trend?.days.length ? "1 day" : "no history"} so far.
      </p>
    );
  }

  const shown = (keys ? trend.series.filter((s) => keys.includes(s.key)) : trend.series).slice(0, 6);
  if (shown.length === 0) return null;

  const n = trend.days.length;
  const maxY = Math.max(1, ...shown.flatMap((s) => s.points));
  const x = (i: number) => PAD + (n <= 1 ? 0 : (i / (n - 1)) * (W - 2 * PAD));
  const y = (v: number) => PAD + (H - 2 * PAD) * (1 - v / maxY);
  const colorFor = (key: string, idx: number) => colors?.[key] ?? PALETTE[idx % PALETTE.length];

  const first = trend.days[0];
  const last = trend.days[n - 1];
  const mid = trend.days[Math.floor((n - 1) / 2)];
  const activeDay = hover != null ? trend.days[hover] : null;

  return (
    <div className="mt-3">
      <div className="flex items-center justify-between text-[10px] text-fg-subtle mb-1">
        <span className="font-medium text-fg-muted">Trend</span>
        <span>{activeDay ?? `${first} → ${last}`}</span>
      </div>

      <div className="flex items-stretch gap-1">
        {/* Y-axis title */}
        <span
          className="text-[9px] text-fg-subtle self-center whitespace-nowrap"
          style={{ writingMode: "vertical-rl", transform: "rotate(180deg)" }}
        >
          {yLabel}
        </span>

        {/* Y tick labels */}
        <div className="flex flex-col justify-between text-[9px] text-fg-subtle text-right w-6 py-px shrink-0">
          <span>{maxY}</span>
          <span>{Math.round(maxY / 2)}</span>
          <span>0</span>
        </div>

        {/* Plot */}
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="flex-1 h-32 rounded border border-border/60 bg-bg-muted/30"
          preserveAspectRatio="none"
          onMouseLeave={() => setHover(null)}
          onMouseMove={(e) => {
            const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
            const rel = ((e.clientX - rect.left) / rect.width) * W;
            const i = Math.round(((rel - PAD) / (W - 2 * PAD)) * (n - 1));
            setHover(Math.max(0, Math.min(n - 1, i)));
          }}
        >
          {/* gridlines: top / middle / baseline */}
          {[0, 0.5, 1].map((f) => (
            <line
              key={f}
              x1={PAD}
              y1={y(maxY * f)}
              x2={W - PAD}
              y2={y(maxY * f)}
              stroke="currentColor"
              strokeOpacity={0.12}
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {shown.map((s, idx) => {
            const c = colorFor(s.key, idx);
            const d = s.points
              .map((v, i) => `${i === 0 ? "M" : "L"} ${x(i).toFixed(1)} ${y(v).toFixed(1)}`)
              .join(" ");
            return (
              <path key={s.key} d={d} fill="none" stroke={c} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
            );
          })}
          {hover != null && (
            <line
              x1={x(hover)}
              y1={PAD}
              x2={x(hover)}
              y2={H - PAD}
              stroke="currentColor"
              strokeOpacity={0.35}
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
          )}
        </svg>
      </div>

      {/* X tick labels + title (aligned under the plot, past the y-axis gutter) */}
      <div className="pl-[3.1rem]">
        <div className="flex justify-between text-[9px] text-fg-subtle mt-0.5">
          <span>{first}</span>
          <span>{mid}</span>
          <span>{last}</span>
        </div>
        <div className="text-center text-[9px] text-fg-subtle">{xLabel}</div>
      </div>

      <div className="flex flex-wrap gap-x-2 gap-y-0.5 mt-1">
        {shown.map((s, idx) => (
          <span key={s.key} className="inline-flex items-center gap-1 text-[10px] text-fg-muted">
            <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: colorFor(s.key, idx) }} />
            {s.key}
            <span className="text-fg-subtle">
              {hover != null ? s.points[hover] : s.points[s.points.length - 1]}
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}

/** Priority-colored strokes so the trend matches the bars. */
export const PRIORITY_TREND_COLORS: Record<string, string> = {
  P0: "hsl(0 80% 62%)",
  P1: "hsl(38 92% 55%)",
  P2: "hsl(220 90% 60%)",
  P3: "hsl(142 70% 45%)",
  Unset: "hsl(215 15% 55%)",
};
