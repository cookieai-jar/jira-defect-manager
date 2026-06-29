/** Tiny inline SVG sparkline for a numeric series. Pure, presentational. */
export function Sparkline({
  values,
  width = 56,
  height = 16,
  className = "text-accent",
  min = 0,
  max = 100,
}: {
  values: number[];
  width?: number;
  height?: number;
  className?: string;
  /** Fixed value range; defaults to the 0–100 health scale. */
  min?: number;
  max?: number;
}) {
  if (values.length < 2) {
    return <span className="inline-block text-fg-subtle/50 text-[10px]" style={{ width }}>—</span>;
  }
  const pad = 1.5;
  const span = Math.max(1, max - min);
  const x = (i: number) => pad + (i / (values.length - 1)) * (width - 2 * pad);
  const y = (v: number) => height - pad - ((Math.max(min, Math.min(max, v)) - min) / span) * (height - 2 * pad);
  const d = values.map((v, i) => `${i === 0 ? "M" : "L"} ${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");
  const last = values[values.length - 1];
  return (
    <svg width={width} height={height} className={className} aria-hidden="true">
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={x(values.length - 1)} cy={y(last)} r="1.6" fill="currentColor" />
    </svg>
  );
}
