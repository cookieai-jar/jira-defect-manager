"use client";

import { useMemo, useState } from "react";
import type { TrendBucket } from "@/types/triage";

interface Props {
  data: TrendBucket[];
}

const WIDTH = 800;
const HEIGHT = 220;
const PADDING = { top: 18, right: 16, bottom: 28, left: 32 };

const CREATED = "hsl(220 90% 60%)";
const RESOLVED = "hsl(142 70% 45%)";

export function TrendChart({ data }: Props) {
  const [hover, setHover] = useState<number | null>(null);

  const { innerW, innerH, maxY, x, y } = useMemo(() => {
    const innerW = WIDTH - PADDING.left - PADDING.right;
    const innerH = HEIGHT - PADDING.top - PADDING.bottom;
    const maxCount = Math.max(
      1,
      ...data.flatMap((d) => [d.created, d.resolved]),
    );
    const maxY = niceMax(maxCount);
    const xs = (i: number) =>
      PADDING.left + (data.length <= 1 ? 0 : (i / (data.length - 1)) * innerW);
    const ys = (v: number) =>
      PADDING.top + innerH - (v / maxY) * innerH;
    return { innerW, innerH, maxY, x: xs, y: ys };
  }, [data]);

  if (data.length === 0) {
    return (
      <div className="text-fg-muted text-sm">No trend data — run a sync.</div>
    );
  }

  const createdPath = lineFrom(data, (d) => d.created, x, y);
  const resolvedPath = lineFrom(data, (d) => d.resolved, x, y);

  // Y axis ticks
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((t) => Math.round(t * maxY));

  // X axis ticks (every ~7 days)
  const xTickIndices: number[] = [];
  const step = Math.max(1, Math.floor(data.length / 5));
  for (let i = 0; i < data.length; i += step) xTickIndices.push(i);
  if (xTickIndices[xTickIndices.length - 1] !== data.length - 1) {
    xTickIndices.push(data.length - 1);
  }

  const totalCreated = data.reduce((n, d) => n + d.created, 0);
  const totalResolved = data.reduce((n, d) => n + d.resolved, 0);
  const net = totalCreated - totalResolved;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-5 text-xs">
        <Legend color={CREATED} label="Created" count={totalCreated} />
        <Legend color={RESOLVED} label="Resolved" count={totalResolved} />
        <span className="text-fg-subtle">
          Net change:{" "}
          <span className={net > 0 ? "text-warning" : net < 0 ? "text-success" : "text-fg-muted"}>
            {net > 0 ? `+${net}` : net}
          </span>
        </span>
      </div>

      <div
        className="relative"
        onMouseLeave={() => setHover(null)}
      >
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          className="w-full h-auto"
          preserveAspectRatio="none"
        >
          {/* Gridlines + Y axis labels */}
          {yTicks.map((v, i) => {
            const yPos = y(v);
            return (
              <g key={i}>
                <line
                  x1={PADDING.left}
                  x2={WIDTH - PADDING.right}
                  y1={yPos}
                  y2={yPos}
                  stroke="hsl(220 13% 20%)"
                  strokeWidth="1"
                  strokeDasharray={i === 0 ? "" : "2 3"}
                />
                <text
                  x={PADDING.left - 6}
                  y={yPos}
                  textAnchor="end"
                  dominantBaseline="middle"
                  fill="hsl(220 8% 45%)"
                  fontSize="10"
                  fontFamily="ui-monospace, Menlo, monospace"
                >
                  {v}
                </text>
              </g>
            );
          })}

          {/* X axis labels */}
          {xTickIndices.map((i) => (
            <text
              key={i}
              x={x(i)}
              y={HEIGHT - PADDING.bottom + 14}
              textAnchor="middle"
              fill="hsl(220 8% 45%)"
              fontSize="10"
              fontFamily="ui-monospace, Menlo, monospace"
            >
              {data[i].date.slice(5)}
            </text>
          ))}

          {/* Resolved line + area */}
          <path
            d={`${resolvedPath} L ${x(data.length - 1)} ${y(0)} L ${x(0)} ${y(0)} Z`}
            fill={RESOLVED}
            fillOpacity="0.05"
          />
          <path
            d={resolvedPath}
            fill="none"
            stroke={RESOLVED}
            strokeWidth="2"
            strokeLinejoin="round"
            strokeLinecap="round"
          />

          {/* Created line + area (drawn second so it sits on top) */}
          <path
            d={`${createdPath} L ${x(data.length - 1)} ${y(0)} L ${x(0)} ${y(0)} Z`}
            fill={CREATED}
            fillOpacity="0.08"
          />
          <path
            d={createdPath}
            fill="none"
            stroke={CREATED}
            strokeWidth="2"
            strokeLinejoin="round"
            strokeLinecap="round"
          />

          {/* Hover hit zones */}
          {data.map((_, i) => {
            const cx = x(i);
            const w = innerW / Math.max(1, data.length - 1);
            return (
              <rect
                key={i}
                x={cx - w / 2}
                y={PADDING.top}
                width={w}
                height={innerH}
                fill="transparent"
                onMouseEnter={() => setHover(i)}
              />
            );
          })}

          {/* Hover indicator */}
          {hover !== null && (
            <>
              <line
                x1={x(hover)}
                x2={x(hover)}
                y1={PADDING.top}
                y2={HEIGHT - PADDING.bottom}
                stroke="hsl(220 10% 96%)"
                strokeWidth="1"
                strokeDasharray="2 3"
                opacity="0.4"
              />
              <circle cx={x(hover)} cy={y(data[hover].created)} r="3.5" fill={CREATED} />
              <circle cx={x(hover)} cy={y(data[hover].resolved)} r="3.5" fill={RESOLVED} />
            </>
          )}
        </svg>

        {hover !== null && (
          <div
            className="absolute -translate-x-1/2 pointer-events-none"
            style={{
              left: `${(x(hover) / WIDTH) * 100}%`,
              top: 0,
            }}
          >
            <div className="mt-1 rounded border border-border-strong bg-bg-card px-2.5 py-1.5 text-[11px] shadow-lg whitespace-nowrap">
              <div className="font-mono text-fg-subtle mb-0.5">{data[hover].date}</div>
              <div className="flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: CREATED }} />
                <span className="text-fg-muted">Created</span>
                <span className="font-mono text-fg ml-1">{data[hover].created}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: RESOLVED }} />
                <span className="text-fg-muted">Resolved</span>
                <span className="font-mono text-fg ml-1">{data[hover].resolved}</span>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Legend({
  color,
  label,
  count,
}: {
  color: string;
  label: string;
  count: number;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span
        className="inline-block h-2 w-3 rounded-sm"
        style={{ background: color }}
      />
      <span className="text-fg-muted">{label}</span>
      <span className="font-mono text-fg">{count}</span>
    </div>
  );
}

function lineFrom(
  data: TrendBucket[],
  pick: (d: TrendBucket) => number,
  x: (i: number) => number,
  y: (v: number) => number,
): string {
  return data
    .map((d, i) => `${i === 0 ? "M" : "L"} ${x(i)} ${y(pick(d))}`)
    .join(" ");
}

function niceMax(v: number): number {
  if (v <= 1) return 1;
  if (v <= 5) return 5;
  if (v <= 10) return 10;
  const order = Math.pow(10, Math.floor(Math.log10(v)));
  const norm = v / order;
  let nice: number;
  if (norm <= 1) nice = 1;
  else if (norm <= 2) nice = 2;
  else if (norm <= 5) nice = 5;
  else nice = 10;
  return nice * order;
}
