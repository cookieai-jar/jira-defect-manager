"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Markdown } from "@/components/markdown";
import { TicketDrawer } from "@/components/ticket-drawer";
import { ProductDefectsSyncButton } from "@/components/product-defects-sync-button";
import { cn } from "@/lib/utils";
import {
  Activity,
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Boxes,
  Bug,
  ChevronDown,
  Code2,
  ExternalLink,
  FileCode2,
  FlaskConical,
  Gauge,
  GitCommitHorizontal,
  Inbox,
  Layers,
  ListChecks,
  Minus,
  Radar,
  ShieldCheck,
  Target,
  Users,
  Wrench,
} from "lucide-react";
import type { JiraIssue } from "@/types/triage";
import {
  ACTION_PRIORITIES,
  DETECTION_STAGE_LABELS,
  DISCIPLINE_LABELS,
  PREVENTION_DISCIPLINES,
  TRIGGER_LABELS,
  type ActionPriority,
  type CodeCorrelation,
  type CodeHotspot,
  type DefectGroup,
  type DefectMetric,
  type DefectSignal,
  type DefectSubGroup,
  type Effort,
  type MetricPoint,
  type PreventionDiscipline,
  type PreventionStrategy,
  type ProductDefectAnalysis,
  type RootCause,
  type TeamActionPlan,
} from "@/types/product-defects";

interface ReportResponse {
  report: ProductDefectAnalysis | null;
  issues: JiraIssue[];
  jiraBaseUrl: string;
}

/** Shared badge palettes — same tokens the Integrations dashboard uses. */
const PRIORITY_STYLES: Record<ActionPriority, string> = {
  now: "border-danger/40 bg-danger/10 text-danger",
  next: "border-warning/40 bg-warning/10 text-warning",
  later: "border-fg-subtle/40 bg-fg-subtle/10 text-fg-muted",
};
const EFFORT_STYLES: Record<Effort, string> = {
  low: "border-success/40 bg-success/10 text-success",
  medium: "border-warning/40 bg-warning/10 text-warning",
  high: "border-danger/40 bg-danger/10 text-danger",
};

const DISCIPLINE_ICONS: Record<PreventionDiscipline, React.ReactNode> = {
  process: <ListChecks className="h-4 w-4 text-accent" />,
  code: <Code2 className="h-4 w-4 text-accent" />,
  quality: <ShieldCheck className="h-4 w-4 text-accent" />,
  "unit-test": <FlaskConical className="h-4 w-4 text-success" />,
  "integration-test": <FlaskConical className="h-4 w-4 text-success" />,
  "e2e-test": <FlaskConical className="h-4 w-4 text-success" />,
  "scale-test": <Gauge className="h-4 w-4 text-warning" />,
  observability: <Radar className="h-4 w-4 text-accent" />,
};

export function ProductDefectsDashboard() {
  const [report, setReport] = useState<ProductDefectAnalysis | null>(null);
  const [issues, setIssues] = useState<JiraIssue[]>([]);
  const [jiraBaseUrl, setJiraBaseUrl] = useState("");
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const data = (await fetch("/api/product-defects/report").then((r) =>
        r.json(),
      )) as ReportResponse;
      setReport(data.report);
      setIssues(data.issues ?? []);
      setJiraBaseUrl(data.jiraBaseUrl ?? "");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Lookups the deep sections need. The report carries ~1300 signals and tens
  // of groups/strategies, so these are built once per report, not per card.
  const signalByKey = useMemo(
    () => new Map((report?.signals ?? []).map((s) => [s.issueKey, s])),
    [report],
  );
  const summaryByKey = useMemo(() => new Map(issues.map((i) => [i.key, i.summary])), [issues]);
  const groupNameByKey = useMemo(
    () => new Map((report?.groups ?? []).map((g) => [g.key, g.name])),
    [report],
  );
  const strategyByKey = useMemo(
    () => new Map((report?.strategies ?? []).map((s) => [s.key, s])),
    [report],
  );
  const metricNameByKey = useMemo(
    () => new Map((report?.metrics ?? []).map((m) => [m.key, m.name])),
    [report],
  );
  /** Where each defect group lives in the code — folded into the group card. */
  const codeByGroup = useMemo(
    () => new Map((report?.codeCorrelation?.byGroup ?? []).map((b) => [b.groupKey, b])),
    [report],
  );

  /**
   * Opening a ticket is a probe, not a straight `setSelected`.
   *
   * TicketDrawer reads `/api/issues/<key>`, which is backed by the shared
   * triage `issues` table — this dashboard's population lives in its own
   * `product_defect_issues` table, so a key outside the triage window 404s and
   * the drawer dereferences the missing issue. Until that route falls back to
   * `getProductDefectIssue`, we check first and send the reader to JIRA when
   * the drawer has nothing to show.
   */
  const openTicket = useCallback(
    async (key: string) => {
      const cached = ticketAvailability.get(key);
      const available = cached ?? (await fetch(`/api/issues/${key}`).then((r) => r.ok, () => false));
      ticketAvailability.set(key, available);
      if (available) setSelected(key);
      else if (jiraBaseUrl) window.open(`${jiraBaseUrl}/browse/${key}`, "_blank", "noreferrer");
    },
    [jiraBaseUrl],
  );

  const ticketCtx: TicketContext = useMemo(
    () => ({ jiraBaseUrl, onSelect: openTicket, signalByKey, summaryByKey }),
    [jiraBaseUrl, openTicket, signalByKey, summaryByKey],
  );

  /**
   * The stored report can lag the cached population — a sync that pulls tickets
   * then dies before writing a report leaves the previous one as "latest", and
   * a narrowed JQL does the same. Without this, an old report reads as the
   * current picture and its headline count looks like a data problem.
   */
  const stale = !!report && issues.length > 0 && issues.length !== report.totalTickets;

  /** Automated metrics with a computable move — the header's headline deltas. */
  const headlineMetrics = useMemo(
    () =>
      (report?.metrics ?? [])
        .filter((m) => m.automated && m.current != null && m.baseline != null)
        .slice(0, 3),
    [report],
  );

  return (
    <div className="flex-1 overflow-auto scroll-thin">
      <header className="px-6 py-2.5 border-b border-border flex items-start justify-between gap-4 sticky top-0 z-10 bg-bg/90 backdrop-blur">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold flex items-center gap-2">
            <Bug className="h-4 w-4 text-accent" /> Product Defect Analysis
          </h1>
          {report && (
            <p className="text-[11px] text-fg-subtle">
              {report.analyzedTickets.toLocaleString()} of {report.totalTickets.toLocaleString()}{" "}
              customer-found defects analyzed · generated{" "}
              {new Date(report.generatedAt).toLocaleString()}
            </p>
          )}
          {stale && (
            <p className="text-[11px] text-warning mt-0.5">
              Stale — {issues.length.toLocaleString()} defects are cached but this report covers{" "}
              {report?.totalTickets.toLocaleString()}. Re-run Sync.
            </p>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <ProductDefectsSyncButton onSynced={refresh} />
        </div>
      </header>

      {!report ? (
        <EmptyState loading={loading} />
      ) : report.analyzedTickets === 0 ? (
        <div className="p-6">
          <Card>
            <CardBody className="text-center text-fg-muted text-sm py-10 space-y-2">
              <Inbox className="h-5 w-5 text-fg-subtle mx-auto" />
              <Markdown>{report.executiveSummary}</Markdown>
              <p className="text-xs text-fg-subtle">
                Adjust the Product Defect Analysis JQL in{" "}
                <a href="/settings" className="text-accent underline">
                  Settings
                </a>{" "}
                and run the analysis again.
              </p>
            </CardBody>
          </Card>
        </div>
      ) : (
        <div className="p-6 space-y-6">
          <TopLine report={report} headlineMetrics={headlineMetrics} />

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Boxes className="h-4 w-4 text-accent" /> Executive summary
              </CardTitle>
              <span className="text-[11px] text-fg-subtle font-mono truncate max-w-[40%]" title={report.jql}>
                {report.jql}
              </span>
            </CardHeader>
            <CardBody>
              <Markdown jiraBaseUrl={jiraBaseUrl}>{report.executiveSummary}</Markdown>
            </CardBody>
          </Card>

          {report.metrics.length > 0 && (
            <MetricsSection metrics={report.metrics} groupNameByKey={groupNameByKey} />
          )}

          <GroupsSection groups={report.groups} codeByGroup={codeByGroup} ticketCtx={ticketCtx} />

          {report.codeCorrelation && (
            <CodeCorrelationSection correlation={report.codeCorrelation} ticketCtx={ticketCtx} />
          )}

          <StrategiesSection
            strategies={report.strategies}
            groupNameByKey={groupNameByKey}
            metricNameByKey={metricNameByKey}
          />

          <TeamPlansSection
            plans={report.teamPlans}
            strategyByKey={strategyByKey}
            metricNameByKey={metricNameByKey}
            ticketCtx={ticketCtx}
          />
        </div>
      )}

      <TicketDrawer issueKey={selected} onClose={() => setSelected(null)} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section 1 — top-line stats
// ---------------------------------------------------------------------------

function TopLine({
  report,
  headlineMetrics,
}: {
  report: ProductDefectAnalysis;
  headlineMetrics: DefectMetric[];
}) {
  const linkRate = report.codeCorrelation?.linkRate ?? null;
  const regressions = useMemo(
    () => report.groups.reduce((n, g) => n + g.regressionCount, 0),
    [report.groups],
  );

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Stat icon={<Inbox className="h-4 w-4" />} label="Defects analyzed" value={report.analyzedTickets} />
        <Stat icon={<Layers className="h-4 w-4 text-accent" />} label="Defect groups" value={report.groups.length} />
        <Stat
          icon={<AlertTriangle className="h-4 w-4 text-warning" />}
          label="Regressions"
          value={regressions}
          tone="warning"
        />
        <Stat
          icon={<GitCommitHorizontal className="h-4 w-4 text-accent" />}
          label="Linked to code"
          value={linkRate == null ? "—" : `${Math.round(linkRate)}%`}
          hint={
            report.codeCorrelation
              ? `${report.codeCorrelation.linkedTickets}/${report.codeCorrelation.totalTickets} tickets`
              : "no correlation run"
          }
        />
        <Stat
          icon={<ListChecks className="h-4 w-4 text-success" />}
          label="Prevention actions"
          value={report.strategies.length}
          tone="success"
        />
      </div>

      {headlineMetrics.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] uppercase tracking-wide text-fg-subtle">Headline metrics</span>
          {headlineMetrics.map((m) => (
            <HeadlineDelta key={m.key} metric={m} />
          ))}
        </div>
      )}
    </div>
  );
}

function HeadlineDelta({ metric }: { metric: DefectMetric }) {
  const d = metricDelta(metric);
  return (
    <span className="inline-flex items-center gap-1.5 rounded border border-border bg-bg-card px-2 py-1 text-[11px]">
      <span className="text-fg-muted">{metric.name}</span>
      <span className="font-mono text-fg">{fmtValue(metric.current, metric.unit)}</span>
      <DeltaLabel delta={d} unit={metric.unit} />
    </span>
  );
}

// ---------------------------------------------------------------------------
// Section 3 — metrics strip
// ---------------------------------------------------------------------------

function MetricsSection({
  metrics,
  groupNameByKey,
}: {
  metrics: DefectMetric[];
  groupNameByKey: Map<string, string>;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const automated = useMemo(() => metrics.filter((m) => m.automated), [metrics]);
  const manual = useMemo(() => metrics.filter((m) => !m.automated), [metrics]);
  const open = automated.find((m) => m.key === expanded) ?? null;

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <Activity className="h-4 w-4 text-accent" />
        <h2 className="text-sm font-semibold">Success metrics</h2>
        <span className="text-xs text-fg-muted">
          {automated.length} automated{manual.length > 0 && ` · ${manual.length} not instrumented yet`}
        </span>
      </div>

      {automated.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
          {automated.map((m) => (
            <MetricTile
              key={m.key}
              metric={m}
              open={expanded === m.key}
              onToggle={() => setExpanded((k) => (k === m.key ? null : m.key))}
            />
          ))}
        </div>
      )}

      {open && (
        <Card id={`metric-panel-${open.key}`}>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Activity className="h-4 w-4 text-accent" /> {open.name}
            </CardTitle>
            <div className="flex items-center gap-1.5">
              <Badge className="font-mono">{open.cadence}</Badge>
              <Badge className="font-mono">{open.source}</Badge>
              <Badge
                className={cn(
                  "border",
                  open.direction === "down-good"
                    ? "border-success/40 bg-success/10 text-success"
                    : "border-accent/40 bg-accent/10 text-accent",
                )}
              >
                {open.direction === "down-good" ? "lower is better" : "higher is better"}
              </Badge>
            </div>
          </CardHeader>
          <CardBody className="space-y-3">
            <p className="text-xs text-fg-muted">{open.definition}</p>
            <MetricTrendChart metric={open} />
            {open.relatedGroupKeys.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[11px] uppercase tracking-wide text-fg-subtle mr-1">Proves out</span>
                {open.relatedGroupKeys.map((k) => (
                  <Badge key={k} className="border-border-strong">
                    {groupNameByKey.get(k) ?? k}
                  </Badge>
                ))}
              </div>
            )}
            {open.howToMeasure && (
              <div className="text-xs border-t border-border pt-2">
                <div className="text-[11px] uppercase tracking-wide text-fg-subtle mb-1">
                  How it is measured
                </div>
                <Markdown>{open.howToMeasure}</Markdown>
              </div>
            )}
          </CardBody>
        </Card>
      )}

      {manual.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Target className="h-4 w-4 text-warning" /> Proposed metrics — not instrumented yet
            </CardTitle>
            <Badge>{manual.length}</Badge>
          </CardHeader>
          <CardBody className="space-y-1.5">
            {manual.map((m) => (
              <ManualMetricRow key={m.key} metric={m} />
            ))}
          </CardBody>
        </Card>
      )}
    </section>
  );
}

function MetricTile({
  metric,
  open,
  onToggle,
}: {
  metric: DefectMetric;
  open: boolean;
  onToggle: () => void;
}) {
  const d = metricDelta(metric);
  const missing = metric.series.filter((p) => p.value == null).length;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      // Only reference the panel while it exists — a dangling aria-controls is
      // worse than none for a screen reader.
      aria-controls={open ? `metric-panel-${metric.key}` : undefined}
      className={cn(
        "text-left rounded border bg-bg-card px-3 py-2.5 transition-colors",
        open ? "border-accent/60" : "border-border hover:border-border-strong",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="text-[11px] uppercase tracking-wide text-fg-muted leading-tight">
          {metric.name}
        </span>
        <ChevronDown
          className={cn("h-3.5 w-3.5 text-fg-subtle transition-transform shrink-0", open ? "rotate-0" : "-rotate-90")}
        />
      </div>
      <div className="mt-1 flex items-baseline gap-1.5">
        <span className="text-2xl font-semibold text-fg">{fmtValue(metric.current, metric.unit)}</span>
        {metric.unit !== "%" && <span className="text-[11px] text-fg-subtle">{metric.unit}</span>}
      </div>
      <div className="mt-0.5 flex items-center gap-1.5 text-[11px]">
        <DeltaLabel delta={d} unit={metric.unit} />
        <span className="text-fg-subtle">vs baseline {fmtValue(metric.baseline, metric.unit)}</span>
      </div>
      <MetricSparkline series={metric.series} tone={d.tone} />
      <div className="mt-1 flex items-center justify-between text-[10px] text-fg-subtle">
        <span>
          {metric.series.length > 0
            ? `${metric.series[0].period} → ${metric.series[metric.series.length - 1].period}`
            : "no history"}
        </span>
        {missing > 0 && <span>{missing} period{missing === 1 ? "" : "s"} w/o data</span>}
      </div>
    </button>
  );
}

function ManualMetricRow({ metric }: { metric: DefectMetric }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded border border-border bg-bg-muted/40">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="w-full px-3 py-2 flex items-center justify-between gap-2 text-left hover:bg-bg-muted/60 transition-colors"
      >
        <span className="flex items-center gap-1.5 min-w-0">
          <ChevronDown
            className={cn("h-3.5 w-3.5 text-fg-muted transition-transform shrink-0", open ? "rotate-0" : "-rotate-90")}
          />
          <span className="text-sm font-medium truncate">{metric.name}</span>
          <span className="text-[11px] text-fg-subtle truncate">· {metric.definition}</span>
        </span>
        <span className="flex items-center gap-1 shrink-0">
          <Badge className="font-mono">{metric.unit}</Badge>
          <Badge className="font-mono">{metric.source}</Badge>
        </span>
      </button>
      {open && (
        <div className="px-3 pb-2.5 pl-8 space-y-1 text-xs">
          <Markdown>{metric.howToMeasure}</Markdown>
          {metric.target != null && (
            <p className="text-[11px] text-fg-subtle">
              Target: <span className="font-mono text-fg-muted">{fmtValue(metric.target, metric.unit)}</span>
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Sparkline over a metric's series.
 *
 * Hand-rolled rather than reusing `Sparkline`/`MiniTrend` for one reason: a
 * `MetricPoint.value` may be null, and both of those take `number[]` and draw a
 * single continuous path — a missing month would be interpolated straight
 * through (or, worse, read as a zero). Here each contiguous run of real values
 * is its own path, so a gap stays a gap. The domain is also derived from the
 * data, not the 0–100 health scale `Sparkline` assumes.
 */
function MetricSparkline({
  series,
  tone,
  height = 30,
}: {
  series: MetricPoint[];
  tone: DeltaTone;
  height?: number;
}) {
  const geom = useMemo(() => sparkGeometry(series, height), [series, height]);
  if (!geom) {
    return <div className="mt-2 h-[30px] text-[10px] text-fg-subtle flex items-end">not enough history</div>;
  }
  return (
    <svg
      viewBox={`0 0 ${SPARK_W} ${height}`}
      className={cn("mt-2 w-full", TONE_TEXT[tone])}
      style={{ height }}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      {geom.segments.map((seg, i) => (
        <path
          key={i}
          d={seg}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      ))}
      {geom.dots.map((p, i) => (
        <circle key={i} cx={p.x} cy={p.y} r={1.6} fill="currentColor" vectorEffect="non-scaling-stroke" />
      ))}
      <circle cx={geom.last.x} cy={geom.last.y} r={2} fill="currentColor" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

const SPARK_W = 160;

interface SparkGeometry {
  segments: string[];
  /** Isolated points (a real value with nulls on both sides) drawn as dots. */
  dots: Array<{ x: number; y: number }>;
  last: { x: number; y: number };
}

function sparkGeometry(series: MetricPoint[], height: number): SparkGeometry | null {
  const nums = series.map((p) => p.value).filter((v): v is number => v != null);
  if (nums.length < 2) return null;
  const pad = 3;
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const span = max - min || Math.abs(max) || 1;
  const lo = min - span * 0.12;
  const hi = max + span * 0.12;
  const n = series.length;
  const x = (i: number) => pad + (n <= 1 ? 0 : (i / (n - 1)) * (SPARK_W - 2 * pad));
  const y = (v: number) => height - pad - ((v - lo) / (hi - lo)) * (height - 2 * pad);

  const segments: string[] = [];
  const dots: SparkGeometry["dots"] = [];
  let run: Array<{ x: number; y: number }> = [];
  const flush = () => {
    if (run.length === 1) dots.push(run[0]);
    else if (run.length > 1) {
      segments.push(run.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" "));
    }
    run = [];
  };
  series.forEach((p, i) => {
    if (p.value == null) flush();
    else run.push({ x: x(i), y: y(p.value) });
  });
  flush();

  const lastIdx = series.reduce((acc, p, i) => (p.value != null ? i : acc), 0);
  return { segments, dots, last: { x: x(lastIdx), y: y(series[lastIdx].value as number) } };
}

const CHART_W = 760;
const CHART_H = 200;
const CHART_PAD = { top: 14, right: 16, bottom: 30, left: 46 };

/**
 * The expanded, axis-labeled version of the tile sparkline. Same gap handling;
 * adds y ticks in the metric's unit, period labels, and baseline/target rules
 * so a reader can see whether the line is on the right side of the target.
 */
function MetricTrendChart({ metric }: { metric: DefectMetric }) {
  const [hover, setHover] = useState<number | null>(null);
  const tone = metricDelta(metric).tone;

  const model = useMemo(() => {
    const nums = metric.series.map((p) => p.value).filter((v): v is number => v != null);
    if (nums.length === 0) return null;
    const refs = [metric.baseline, metric.target].filter((v): v is number => v != null);
    const min = Math.min(...nums, ...refs, 0);
    const max = Math.max(...nums, ...refs);
    const hi = niceMax(max === min ? max + 1 : max);
    const innerW = CHART_W - CHART_PAD.left - CHART_PAD.right;
    const innerH = CHART_H - CHART_PAD.top - CHART_PAD.bottom;
    const n = metric.series.length;
    const x = (i: number) => CHART_PAD.left + (n <= 1 ? 0 : (i / (n - 1)) * innerW);
    const y = (v: number) => CHART_PAD.top + innerH - ((v - min) / (hi - min || 1)) * innerH;

    const segments: string[] = [];
    let run: Array<{ x: number; y: number }> = [];
    const flush = () => {
      if (run.length > 1) {
        segments.push(run.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" "));
      }
      run = [];
    };
    const dots: Array<{ x: number; y: number; i: number }> = [];
    metric.series.forEach((p, i) => {
      if (p.value == null) {
        flush();
        return;
      }
      const pt = { x: x(i), y: y(p.value) };
      run.push(pt);
      dots.push({ ...pt, i });
    });
    flush();

    const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => min + t * (hi - min));
    // ~6 period labels regardless of series length — YYYY-MM labels collide
    // past that at this width.
    const step = Math.max(1, Math.ceil(n / 6));
    const xTicks: number[] = [];
    for (let i = 0; i < n; i += step) xTicks.push(i);
    if (xTicks[xTicks.length - 1] !== n - 1) xTicks.push(n - 1);
    return { x, y, min, hi, innerW, innerH, segments, dots, ticks, xTicks, n };
  }, [metric]);

  if (!model) {
    return <p className="text-sm text-fg-muted">No history for this metric yet.</p>;
  }

  const hovered = hover == null ? null : metric.series[hover];

  return (
    <div className="space-y-1">
      <div className="relative" onMouseLeave={() => setHover(null)}>
        <svg viewBox={`0 0 ${CHART_W} ${CHART_H}`} className="w-full h-auto" role="img"
          aria-label={`${metric.name} by ${metric.cadence} period, in ${metric.unit}`}>
          {model.ticks.map((v, i) => (
            <g key={i}>
              <line
                x1={CHART_PAD.left}
                x2={CHART_W - CHART_PAD.right}
                y1={model.y(v)}
                y2={model.y(v)}
                stroke="hsl(220 13% 20%)"
                strokeWidth="1"
                strokeDasharray={i === 0 ? "" : "2 3"}
              />
              <text
                x={CHART_PAD.left - 6}
                y={model.y(v)}
                textAnchor="end"
                dominantBaseline="middle"
                fill="hsl(220 8% 45%)"
                fontSize="10"
                fontFamily="ui-monospace, Menlo, monospace"
              >
                {fmtNumber(v)}
              </text>
            </g>
          ))}

          {model.xTicks.map((i) => (
            <text
              key={i}
              x={model.x(i)}
              y={CHART_H - CHART_PAD.bottom + 14}
              textAnchor="middle"
              fill="hsl(220 8% 45%)"
              fontSize="10"
              fontFamily="ui-monospace, Menlo, monospace"
            >
              {metric.series[i].period}
            </text>
          ))}

          {metric.baseline != null && (
            <ReferenceLine y={model.y(metric.baseline)} label="baseline" color="hsl(220 8% 45%)" />
          )}
          {metric.target != null && (
            <ReferenceLine y={model.y(metric.target)} label="target" color="hsl(142 70% 45%)" />
          )}

          {model.segments.map((d, i) => (
            <path
              key={i}
              d={d}
              fill="none"
              className={TONE_TEXT[tone]}
              stroke="currentColor"
              strokeWidth="2"
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          ))}
          {model.dots.map((p) => (
            <circle key={p.i} cx={p.x} cy={p.y} r={2.5} className={TONE_TEXT[tone]} fill="currentColor" />
          ))}

          {/* Hover hit zones — wider than the marks so the crosshair is easy to hit. */}
          {metric.series.map((_, i) => (
            <rect
              key={i}
              x={model.x(i) - model.innerW / Math.max(1, model.n - 1) / 2}
              y={CHART_PAD.top}
              width={model.innerW / Math.max(1, model.n - 1)}
              height={model.innerH}
              fill="transparent"
              onMouseEnter={() => setHover(i)}
            />
          ))}

          {hover != null && (
            <line
              x1={model.x(hover)}
              x2={model.x(hover)}
              y1={CHART_PAD.top}
              y2={CHART_H - CHART_PAD.bottom}
              stroke="hsl(220 10% 96%)"
              strokeWidth="1"
              strokeDasharray="2 3"
              opacity="0.4"
            />
          )}
        </svg>

        {hovered && (
          <div
            className="absolute -translate-x-1/2 pointer-events-none"
            style={{ left: `${(model.x(hover as number) / CHART_W) * 100}%`, top: 0 }}
          >
            <div className="mt-1 rounded border border-border-strong bg-bg-card px-2.5 py-1.5 text-[11px] shadow-lg whitespace-nowrap">
              <div className="font-mono text-fg-subtle mb-0.5">{hovered.period}</div>
              <div className="text-fg">
                {hovered.value == null ? (
                  <span className="text-fg-subtle">no data</span>
                ) : (
                  <span className="font-mono">{fmtValue(hovered.value, metric.unit)}</span>
                )}
              </div>
              {hovered.numerator != null && hovered.denominator != null && (
                <div className="text-fg-subtle font-mono">
                  {hovered.numerator}/{hovered.denominator}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
      <div className="flex items-center justify-between text-[10px] text-fg-subtle">
        <span>{metric.cadence} periods</span>
        <span>{metric.unit}</span>
      </div>
    </div>
  );
}

function ReferenceLine({ y, label, color }: { y: number; label: string; color: string }) {
  return (
    <g>
      <line
        x1={CHART_PAD.left}
        x2={CHART_W - CHART_PAD.right}
        y1={y}
        y2={y}
        stroke={color}
        strokeWidth="1"
        strokeDasharray="5 4"
        opacity="0.8"
      />
      <text
        x={CHART_W - CHART_PAD.right}
        y={y - 3}
        textAnchor="end"
        fill={color}
        fontSize="9"
        fontFamily="ui-monospace, Menlo, monospace"
      >
        {label}
      </text>
    </g>
  );
}

// ---------------------------------------------------------------------------
// Section 4 — defect groups
// ---------------------------------------------------------------------------

type GroupCodeLink = CodeCorrelation["byGroup"][number];

function GroupsSection({
  groups,
  codeByGroup,
  ticketCtx,
}: {
  groups: DefectGroup[];
  codeByGroup: Map<string, GroupCodeLink>;
  ticketCtx: TicketContext;
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <Layers className="h-4 w-4 text-accent" />
        <h2 className="text-sm font-semibold">Defect groups</h2>
        <span className="text-xs text-fg-muted">{groups.length} groups · by share of analyzed defects</span>
      </div>
      {groups.length === 0 ? (
        <Card>
          <CardBody className="text-fg-muted text-sm py-6 text-center">No groups were produced.</CardBody>
        </Card>
      ) : (
        <CappedList items={groups} initial={12} className="space-y-3" noun="group">
          {(g, i) => (
            <GroupCard
              key={g.key}
              group={g}
              code={codeByGroup.get(g.key)}
              defaultOpen={i === 0}
              ticketCtx={ticketCtx}
            />
          )}
        </CappedList>
      )}
    </section>
  );
}

function GroupCard({
  group,
  code,
  defaultOpen,
  ticketCtx,
}: {
  group: DefectGroup;
  code?: GroupCodeLink;
  defaultOpen?: boolean;
  ticketCtx: TicketContext;
}) {
  const [open, setOpen] = useState(defaultOpen ?? false);
  return (
    <Card className="overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className={cn(
          "w-full px-4 py-3 flex items-center justify-between gap-3 text-left transition-colors",
          open ? "border-b border-border bg-bg-muted/40" : "hover:bg-bg-muted/40",
        )}
      >
        <div className="flex items-center gap-2 min-w-0">
          <ChevronDown
            className={cn("h-4 w-4 text-fg-muted transition-transform shrink-0", open ? "rotate-0" : "-rotate-90")}
          />
          <div className="min-w-0">
            <h3 className="text-sm font-semibold truncate">{group.name}</h3>
            <p className="text-[11px] text-fg-subtle truncate">{group.description}</p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {group.regressionCount > 0 && (
            <Badge className="border border-warning/40 bg-warning/10 text-warning">
              {group.regressionCount} regr
            </Badge>
          )}
          <ScorePill label="sev" value={group.severityAvg} />
          <ScorePill label="prev" value={group.preventabilityAvg} />
          <Badge className="border-accent/40 bg-accent/10 text-accent border font-mono">{group.share}%</Badge>
          <span className="text-[11px] text-fg-subtle">
            <span className="text-fg-muted">{group.ticketCount}</span> tickets
          </span>
        </div>
      </button>

      {open && (
        <CardBody className="space-y-4">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <DistBars
              title="Should have been caught at"
              items={group.detectionStages.map((d) => ({
                label: DETECTION_STAGE_LABELS[d.stage],
                count: d.count,
              }))}
              total={group.ticketCount}
              barClass="bg-warning"
            />
            <DistBars
              title="Triggered by"
              items={group.triggers.map((t) => ({ label: TRIGGER_LABELS[t.trigger], count: t.count }))}
              total={group.ticketCount}
              barClass="bg-accent"
            />
          </div>

          {group.topAreas.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] uppercase tracking-wide text-fg-subtle mr-1">Areas</span>
              {group.topAreas.slice(0, 12).map((a) => (
                <Badge key={a} className="border-border-strong">
                  {a}
                </Badge>
              ))}
            </div>
          )}

          {group.analysis && (
            <Panel title="What fails and why" icon={<Wrench className="h-3.5 w-3.5 text-accent" />}>
              <Markdown jiraBaseUrl={ticketCtx.jiraBaseUrl}>{group.analysis}</Markdown>
            </Panel>
          )}
          {group.escapeAnalysis && (
            <Panel title="Why it escaped us" icon={<AlertTriangle className="h-3.5 w-3.5 text-warning" />}>
              <Markdown jiraBaseUrl={ticketCtx.jiraBaseUrl}>{group.escapeAnalysis}</Markdown>
            </Panel>
          )}

          <GroupCodePanel code={code} jiraBaseUrl={ticketCtx.jiraBaseUrl} />

          <RootCauseList causes={group.rootCauses} ticketCtx={ticketCtx} />

          {group.subGroups.length > 0 && (
            <div className="space-y-2">
              <div className="text-[11px] uppercase tracking-wide text-fg-subtle">
                Sub-groups ({group.subGroups.length})
              </div>
              <div className="space-y-1.5">
                {group.subGroups.map((sg) => (
                  <SubGroupRow key={sg.key} subGroup={sg} ticketCtx={ticketCtx} />
                ))}
              </div>
            </div>
          )}

          {group.exampleQuotes.length > 0 && (
            <div className="space-y-1">
              <div className="text-[11px] uppercase tracking-wide text-fg-subtle">Example signals</div>
              <ul className="space-y-1">
                {group.exampleQuotes.slice(0, 6).map((q, i) => (
                  <li key={i} className="text-xs text-fg-muted border-l-2 border-border pl-2 italic">
                    “{q}”
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="pt-2 border-t border-border">
            <div className="text-[11px] uppercase tracking-wide text-fg-subtle mb-1">
              Tickets ({group.issueKeys.length})
            </div>
            <TicketList keys={group.issueKeys} ctx={ticketCtx} />
          </div>
        </CardBody>
      )}
    </Card>
  );
}

function SubGroupRow({ subGroup, ticketCtx }: { subGroup: DefectSubGroup; ticketCtx: TicketContext }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded border border-border bg-bg-muted/30">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="w-full px-2.5 py-1.5 flex items-center justify-between gap-2 text-left hover:bg-bg-muted/50 transition-colors rounded"
      >
        <span className="flex items-center gap-1.5 min-w-0">
          <ChevronDown
            className={cn("h-3.5 w-3.5 text-fg-muted transition-transform shrink-0", open ? "rotate-0" : "-rotate-90")}
          />
          <span className="text-sm font-medium truncate">{subGroup.name}</span>
          <span className="text-[11px] text-fg-subtle truncate">· {subGroup.description}</span>
        </span>
        <span className="flex items-center gap-2 shrink-0">
          <Badge className="border-accent/40 bg-accent/10 text-accent border font-mono">{subGroup.share}%</Badge>
          <span className="text-[11px] text-fg-muted font-mono">{subGroup.ticketCount}</span>
        </span>
      </button>
      {open && (
        <div className="px-3 pb-3 pt-1 space-y-3">
          {subGroup.topAreas.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {subGroup.topAreas.slice(0, 10).map((a) => (
                <Badge key={a} className="border-border-strong">
                  {a}
                </Badge>
              ))}
            </div>
          )}
          <RootCauseList causes={subGroup.rootCauses} ticketCtx={ticketCtx} />
          {subGroup.exampleQuotes.length > 0 && (
            <ul className="space-y-1">
              {subGroup.exampleQuotes.slice(0, 4).map((q, i) => (
                <li key={i} className="text-xs text-fg-muted border-l-2 border-border pl-2 italic">
                  “{q}”
                </li>
              ))}
            </ul>
          )}
          <TicketList keys={subGroup.issueKeys} ctx={ticketCtx} initial={6} />
        </div>
      )}
    </div>
  );
}

/** The group's footprint in the repo — who owns it and which paths it touches. */
function GroupCodePanel({ code, jiraBaseUrl }: { code?: GroupCodeLink; jiraBaseUrl: string }) {
  if (!code || (code.areaHotspots.length === 0 && code.fileHotspots.length === 0)) return null;
  const paths = (code.areaHotspots.length > 0 ? code.areaHotspots : code.fileHotspots).slice(0, 5);
  return (
    <Panel title="Where it lives in the code" icon={<Code2 className="h-3.5 w-3.5 text-accent" />}>
      <div className="space-y-1.5">
        <div className="text-[11px] text-fg-subtle">
          {code.linkedTickets} of this group&rsquo;s tickets traced to a fix commit
        </div>
        {code.teams.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {code.teams.map((t) => (
              <Badge key={t} className="border-border-strong font-mono normal-case">
                {t}
              </Badge>
            ))}
          </div>
        )}
        {paths.map((h) => (
          <div key={h.path} className="flex items-center justify-between gap-2">
            <span className="font-mono text-[11px] text-fg-muted truncate" title={h.path}>
              {h.path}
            </span>
            <JiraQueryLink
              keys={h.issueKeys}
              jiraBaseUrl={jiraBaseUrl}
              label={`${h.defectCount} defects`}
            />
          </div>
        ))}
      </div>
    </Panel>
  );
}

function RootCauseList({ causes, ticketCtx }: { causes: RootCause[]; ticketCtx: TicketContext }) {
  if (causes.length === 0) return null;
  return (
    <div className="space-y-2">
      <div className="text-[11px] uppercase tracking-wide text-fg-subtle">Root causes ({causes.length})</div>
      <ul className="space-y-2.5">
        {causes.map((rc, i) => (
          <li key={i} className="rounded border border-border bg-bg-muted/40 px-3 py-2 space-y-1">
            <div className="text-sm font-medium text-fg flex items-center gap-1.5">
              <AlertTriangle className="h-3.5 w-3.5 text-warning shrink-0" />
              {rc.title}
            </div>
            {rc.explanation && (
              <div className="text-xs">
                <Markdown jiraBaseUrl={ticketCtx.jiraBaseUrl}>{rc.explanation}</Markdown>
              </div>
            )}
            {rc.contributingFactors.length > 0 && (
              <ul className="text-xs text-fg-muted list-disc pl-4">
                {rc.contributingFactors.map((f, j) => (
                  <li key={j}>{f}</li>
                ))}
              </ul>
            )}
            {rc.issueKeys.length > 0 && (
              <JiraQueryLink
                keys={rc.issueKeys}
                jiraBaseUrl={ticketCtx.jiraBaseUrl}
                label={`Evidence · ${rc.issueKeys.length} ticket${rc.issueKeys.length === 1 ? "" : "s"} in JIRA`}
              />
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section 5 — code correlation
// ---------------------------------------------------------------------------

function CodeCorrelationSection({
  correlation,
  ticketCtx,
}: {
  correlation: CodeCorrelation;
  ticketCtx: TicketContext;
}) {
  const totalFixes = correlation.fixesWithTests + correlation.fixesWithoutTests;
  const testedPct = totalFixes === 0 ? 0 : Math.round((correlation.fixesWithTests / totalFixes) * 100);

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <Code2 className="h-4 w-4 text-accent" />
        <h2 className="text-sm font-semibold">Code correlation</h2>
        <span className="text-xs text-fg-muted font-mono truncate">
          {correlation.repoPath}
          {correlation.repoHead && ` @ ${correlation.repoHead.slice(0, 8)}`}
        </span>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat
          icon={<GitCommitHorizontal className="h-4 w-4 text-accent" />}
          label="Link rate"
          value={`${Math.round(correlation.linkRate)}%`}
          hint={`${correlation.linkedTickets}/${correlation.totalTickets} defects traced to a fix commit`}
        />
        <Stat
          icon={<FileCode2 className="h-4 w-4 text-warning" />}
          label="Hot files"
          value={correlation.fileHotspots.length}
          tone="warning"
        />
        <Stat icon={<Users className="h-4 w-4 text-accent" />} label="Owning teams" value={correlation.byTeam.length} />
        <Stat
          icon={<FlaskConical className="h-4 w-4 text-success" />}
          label="Fixes with a test"
          value={`${testedPct}%`}
          tone={testedPct >= 50 ? "success" : "danger"}
          hint={`${correlation.fixesWithTests} with · ${correlation.fixesWithoutTests} without`}
        />
      </div>

      {totalFixes > 0 && (
        <Card>
          <CardBody className="space-y-1.5">
            <div className="flex items-center justify-between text-[11px]">
              <span className="text-fg-muted">Fix commits that changed a test</span>
              <span className="font-mono text-fg-subtle">
                {correlation.fixesWithTests} / {totalFixes}
              </span>
            </div>
            {/* 2px gap between the two fills so they read as separate quantities. */}
            <div className="flex h-2.5 w-full gap-[2px] overflow-hidden rounded">
              <div className="bg-success" style={{ width: `${testedPct}%` }} />
              <div className="bg-danger/60" style={{ width: `${100 - testedPct}%` }} />
            </div>
            <div className="flex items-center gap-4 text-[10px] text-fg-subtle">
              <LegendDot className="bg-success" label={`with tests · ${correlation.fixesWithTests}`} />
              <LegendDot className="bg-danger/60" label={`without tests · ${correlation.fixesWithoutTests}`} />
            </div>
          </CardBody>
        </Card>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3 items-start">
        <HotspotCard
          title="Hottest code areas"
          subtitle="Directories generating the most customer-found defects"
          icon={<Boxes className="h-4 w-4 text-warning" />}
          hotspots={correlation.areaHotspots}
          ticketCtx={ticketCtx}
        />
        <HotspotCard
          title="Hottest files"
          subtitle="Individual files fixed for the most distinct defects"
          icon={<FileCode2 className="h-4 w-4 text-warning" />}
          hotspots={correlation.fileHotspots}
          ticketCtx={ticketCtx}
        />
      </div>

      {correlation.byTeam.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Users className="h-4 w-4 text-accent" /> By owning team
            </CardTitle>
            <Badge>{correlation.byTeam.length}</Badge>
          </CardHeader>
          <CardBody>
            <div className="grid grid-cols-[minmax(0,1fr)_auto_auto_auto_9rem] gap-x-3 gap-y-1 items-center text-[11px]">
              <span className="uppercase tracking-wide text-fg-subtle">Team</span>
              <span className="uppercase tracking-wide text-fg-subtle text-right">Defects</span>
              <span className="uppercase tracking-wide text-fg-subtle text-right">Files</span>
              <span className="uppercase tracking-wide text-fg-subtle text-right">Commits</span>
              <span className="uppercase tracking-wide text-fg-subtle">Fixes w/ test</span>
              <CappedList items={correlation.byTeam} initial={10} className="contents" noun="team">
                {(t) => (
                  <TeamStatsRow key={t.team} stats={t} jiraBaseUrl={ticketCtx.jiraBaseUrl} />
                )}
              </CappedList>
            </div>
          </CardBody>
        </Card>
      )}
    </section>
  );
}

function TeamStatsRow({
  stats,
  jiraBaseUrl,
}: {
  stats: CodeCorrelation["byTeam"][number];
  jiraBaseUrl: string;
}) {
  // `testChangeRate` is documented as a "share" while its sibling `linkRate` is
  // documented as 0-100, so accept either rather than render a 0.34% bar.
  const pct = Math.round(stats.testChangeRate <= 1 ? stats.testChangeRate * 100 : stats.testChangeRate);
  const tone = pct >= 60 ? "bg-success" : pct >= 30 ? "bg-warning" : "bg-danger";
  return (
    <>
      <span className="font-mono text-fg truncate" title={stats.team}>
        {stats.team}
      </span>
      <span className="font-mono text-right text-fg-muted">
        <JiraQueryLink keys={stats.issueKeys} jiraBaseUrl={jiraBaseUrl} label={String(stats.defectCount)} />
      </span>
      <span className="font-mono text-right text-fg-subtle">{stats.fileCount}</span>
      <span className="font-mono text-right text-fg-subtle">{stats.commitCount}</span>
      <span className="flex items-center gap-1.5">
        <span className="h-1.5 flex-1 rounded-full bg-bg-muted overflow-hidden">
          <span className={cn("block h-full rounded-full", tone)} style={{ width: `${pct}%` }} />
        </span>
        <span className="font-mono text-fg-subtle w-8 text-right">{pct}%</span>
      </span>
    </>
  );
}

function HotspotCard({
  title,
  subtitle,
  icon,
  hotspots,
  ticketCtx,
}: {
  title: string;
  subtitle: string;
  icon: React.ReactNode;
  hotspots: CodeHotspot[];
  ticketCtx: TicketContext;
}) {
  const max = hotspots.reduce((m, h) => Math.max(m, h.defectCount), 0);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {icon} {title}
        </CardTitle>
        <Badge>{hotspots.length}</Badge>
      </CardHeader>
      <CardBody className="space-y-2">
        <p className="text-[11px] text-fg-subtle">{subtitle}</p>
        {hotspots.length === 0 ? (
          <p className="text-sm text-fg-muted">Nothing correlated.</p>
        ) : (
          <CappedList items={hotspots} initial={8} className="space-y-1.5" noun="path">
            {(h) => (
              <div key={h.path} className="space-y-0.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-[11px] text-fg truncate" title={h.path}>
                    {h.path}
                  </span>
                  <span className="shrink-0 flex items-center gap-2">
                    {h.fileCount > 1 && (
                      <span className="text-[10px] text-fg-subtle">{h.fileCount} files</span>
                    )}
                    <JiraQueryLink
                      keys={h.issueKeys}
                      jiraBaseUrl={ticketCtx.jiraBaseUrl}
                      label={`${h.defectCount} defects`}
                    />
                  </span>
                </div>
                <div className="h-1.5 w-full rounded-full bg-bg-muted overflow-hidden">
                  <div
                    className="h-full rounded-full bg-warning"
                    style={{ width: `${max === 0 ? 0 : (h.defectCount / max) * 100}%` }}
                  />
                </div>
                {h.teams.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {h.teams.slice(0, 3).map((t) => (
                      <span key={t} className="text-[10px] font-mono text-fg-subtle">
                        {t}
                      </span>
                    ))}
                    {h.teams.length > 3 && (
                      <span className="text-[10px] text-fg-subtle">+{h.teams.length - 3}</span>
                    )}
                  </div>
                )}
              </div>
            )}
          </CappedList>
        )}
      </CardBody>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Section 6 — prevention strategies
// ---------------------------------------------------------------------------

function StrategiesSection({
  strategies,
  groupNameByKey,
  metricNameByKey,
}: {
  strategies: PreventionStrategy[];
  groupNameByKey: Map<string, string>;
  metricNameByKey: Map<string, string>;
}) {
  const [discipline, setDiscipline] = useState<PreventionDiscipline | "all">("all");
  const [priority, setPriority] = useState<ActionPriority | "all">("all");

  const filtered = useMemo(
    () =>
      strategies.filter(
        (s) =>
          (discipline === "all" || s.discipline === discipline) &&
          (priority === "all" || s.priority === priority),
      ),
    [strategies, discipline, priority],
  );

  /** Only offer a discipline filter for disciplines that actually have actions. */
  const disciplinesPresent = useMemo(() => {
    const counts = new Map<PreventionDiscipline, number>();
    for (const s of strategies) counts.set(s.discipline, (counts.get(s.discipline) ?? 0) + 1);
    return PREVENTION_DISCIPLINES.filter((d) => counts.has(d)).map((d) => ({
      discipline: d,
      count: counts.get(d) ?? 0,
    }));
  }, [strategies]);

  const byDiscipline = useMemo(() => {
    const map = new Map<PreventionDiscipline, PreventionStrategy[]>();
    for (const s of filtered) {
      const arr = map.get(s.discipline) ?? [];
      arr.push(s);
      map.set(s.discipline, arr);
    }
    // Fixed discipline order, and "now" first inside each — this is a to-do list.
    const rank: Record<ActionPriority, number> = { now: 0, next: 1, later: 2 };
    return PREVENTION_DISCIPLINES.filter((d) => map.has(d)).map((d) => ({
      discipline: d,
      items: (map.get(d) ?? []).sort((a, b) => rank[a.priority] - rank[b.priority]),
    }));
  }, [filtered]);

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <ShieldCheck className="h-4 w-4 text-success" />
        <h2 className="text-sm font-semibold">Prevention strategies</h2>
        <span className="text-xs text-fg-muted">
          {filtered.length} of {strategies.length} actions
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <FilterChip active={discipline === "all"} onClick={() => setDiscipline("all")}>
          All disciplines
        </FilterChip>
        {disciplinesPresent.map(({ discipline: d, count }) => (
          <FilterChip key={d} active={discipline === d} onClick={() => setDiscipline(d)}>
            {DISCIPLINE_LABELS[d]} <span className="font-mono text-fg-subtle">{count}</span>
          </FilterChip>
        ))}
        <span className="mx-1 h-4 w-px bg-border" aria-hidden="true" />
        <FilterChip active={priority === "all"} onClick={() => setPriority("all")}>
          All priorities
        </FilterChip>
        {ACTION_PRIORITIES.map((p) => (
          <FilterChip
            key={p}
            active={priority === p}
            onClick={() => setPriority(p)}
            className={priority === p ? undefined : PRIORITY_STYLES[p]}
          >
            {p}
          </FilterChip>
        ))}
      </div>

      {byDiscipline.length === 0 ? (
        <Card>
          <CardBody className="text-fg-muted text-sm py-6 text-center">
            No actions match this filter.
          </CardBody>
        </Card>
      ) : (
        <div className="space-y-3">
          {byDiscipline.map(({ discipline: d, items }) => (
            <Card key={d}>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  {DISCIPLINE_ICONS[d]} {DISCIPLINE_LABELS[d]}
                </CardTitle>
                <Badge>{items.length}</Badge>
              </CardHeader>
              <CardBody>
                <CappedList items={items} initial={8} className="space-y-1.5" noun="action">
                  {(s) => (
                    <StrategyRow
                      key={s.key}
                      strategy={s}
                      groupNameByKey={groupNameByKey}
                      metricNameByKey={metricNameByKey}
                    />
                  )}
                </CappedList>
              </CardBody>
            </Card>
          ))}
        </div>
      )}
    </section>
  );
}

function StrategyRow({
  strategy,
  groupNameByKey,
  metricNameByKey,
}: {
  strategy: PreventionStrategy;
  groupNameByKey: Map<string, string>;
  metricNameByKey: Map<string, string>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded border border-border bg-bg-muted/40">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="w-full px-3 py-2 flex items-start justify-between gap-2 text-left hover:bg-bg-muted/60 transition-colors"
      >
        <div className="flex items-start gap-1.5 min-w-0">
          <ChevronDown
            className={cn(
              "h-3.5 w-3.5 text-fg-muted transition-transform shrink-0 mt-0.5",
              open ? "rotate-0" : "-rotate-90",
            )}
          />
          <div className="min-w-0">
            <span className="text-sm font-medium text-fg">{strategy.title}</span>
            <span className="block text-[11px] text-fg-subtle font-mono truncate">{strategy.team}</span>
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Badge className={cn("border", PRIORITY_STYLES[strategy.priority])}>{strategy.priority}</Badge>
          <Badge className={cn("border", EFFORT_STYLES[strategy.effort])}>{strategy.effort} effort</Badge>
        </div>
      </button>
      {open && (
        <div className="px-3 pb-2.5 pl-8 space-y-2">
          {strategy.detail && (
            <div className="text-xs">
              <Markdown>{strategy.detail}</Markdown>
            </div>
          )}
          {strategy.expectedImpact && (
            <Panel title="Expected impact" icon={<Target className="h-3.5 w-3.5 text-success" />}>
              <Markdown>{strategy.expectedImpact}</Markdown>
            </Panel>
          )}
          <ChipRow
            label="Addresses"
            values={strategy.groupKeys.map((k) => groupNameByKey.get(k) ?? k)}
          />
          <ChipRow
            label="Proven by"
            values={strategy.metricKeys.map((k) => metricNameByKey.get(k) ?? k)}
          />
          <ChipRow label="Code" values={strategy.codeAreas} mono />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section 7 — team action plans
// ---------------------------------------------------------------------------

function TeamPlansSection({
  plans,
  strategyByKey,
  metricNameByKey,
  ticketCtx,
}: {
  plans: TeamActionPlan[];
  strategyByKey: Map<string, PreventionStrategy>;
  metricNameByKey: Map<string, string>;
  ticketCtx: TicketContext;
}) {
  if (plans.length === 0) return null;
  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <Users className="h-4 w-4 text-accent" />
        <h2 className="text-sm font-semibold">Team action plans</h2>
        <span className="text-xs text-fg-muted">{plans.length} teams · read your own card</span>
      </div>
      <CappedList items={plans} initial={8} className="grid grid-cols-1 xl:grid-cols-2 gap-3 items-start" noun="team">
        {(p) => (
          <TeamPlanCard
            key={p.team}
            plan={p}
            strategyByKey={strategyByKey}
            metricNameByKey={metricNameByKey}
            ticketCtx={ticketCtx}
          />
        )}
      </CappedList>
    </section>
  );
}

function TeamPlanCard({
  plan,
  strategyByKey,
  metricNameByKey,
  ticketCtx,
}: {
  plan: TeamActionPlan;
  strategyByKey: Map<string, PreventionStrategy>;
  metricNameByKey: Map<string, string>;
  ticketCtx: TicketContext;
}) {
  const maxGroup = plan.topGroups.reduce((m, g) => Math.max(m, g.ticketCount), 0);
  const strategies = plan.strategyKeys
    .map((k) => strategyByKey.get(k))
    .filter((s): s is PreventionStrategy => Boolean(s));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 min-w-0">
          <Users className="h-4 w-4 text-accent shrink-0" />
          <span className="truncate">{plan.label}</span>
          <span className="text-[11px] font-normal font-mono text-fg-subtle truncate">{plan.team}</span>
        </CardTitle>
        <Badge className="border-accent/40 bg-accent/10 text-accent border font-mono">
          {plan.defectCount} defects
        </Badge>
      </CardHeader>
      <CardBody className="space-y-3">
        {plan.summary && (
          <div className="text-xs">
            <Markdown jiraBaseUrl={ticketCtx.jiraBaseUrl}>{plan.summary}</Markdown>
          </div>
        )}

        {plan.topGroups.length > 0 && (
          <div className="space-y-1">
            <div className="text-[11px] uppercase tracking-wide text-fg-subtle">Their top defect groups</div>
            {plan.topGroups.slice(0, 6).map((g) => (
              <div key={g.groupKey} className="space-y-0.5">
                <div className="flex items-center justify-between gap-2 text-[11px]">
                  <span className="text-fg-muted truncate">{g.name}</span>
                  <span className="font-mono text-fg-subtle">{g.ticketCount}</span>
                </div>
                <div className="h-1.5 w-full rounded-full bg-bg-muted overflow-hidden">
                  <div
                    className="h-full rounded-full bg-accent"
                    style={{ width: `${maxGroup === 0 ? 0 : (g.ticketCount / maxGroup) * 100}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        )}

        <ChipRow label="Code areas" values={plan.topAreas.slice(0, 8)} mono />

        {strategies.length > 0 && (
          <div className="space-y-1">
            <div className="text-[11px] uppercase tracking-wide text-fg-subtle">
              Assigned actions ({strategies.length})
            </div>
            <ul className="space-y-1">
              {strategies.map((s) => (
                <li key={s.key} className="flex items-start justify-between gap-2">
                  <span className="flex items-start gap-1.5 min-w-0">
                    <ListChecks className="h-3 w-3 text-success mt-0.5 shrink-0" />
                    <span className="text-[11px] text-fg-muted">
                      {s.title}
                      <span className="text-fg-subtle"> · {DISCIPLINE_LABELS[s.discipline]}</span>
                    </span>
                  </span>
                  <Badge className={cn("border shrink-0", PRIORITY_STYLES[s.priority])}>{s.priority}</Badge>
                </li>
              ))}
            </ul>
          </div>
        )}

        <ChipRow
          label="Watch these metrics"
          values={plan.metricKeys.map((k) => metricNameByKey.get(k) ?? k)}
        />

        <div className="pt-2 border-t border-border">
          <TicketList keys={plan.issueKeys} ctx={ticketCtx} initial={6} />
        </div>
      </CardBody>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

/**
 * Which keys the shared `/api/issues/<key>` route can actually serve. Module
 * scope because it describes the backend, not a card, and re-probing the same
 * ticket on every click would be wasteful.
 */
const ticketAvailability = new Map<string, boolean>();

interface TicketContext {
  jiraBaseUrl: string;
  onSelect: (key: string) => void;
  signalByKey: Map<string, DefectSignal>;
  summaryByKey: Map<string, string>;
}

/**
 * Ticket keys as a capped, clickable list. The population is ~1300 tickets and
 * a single group can hold hundreds, so only a slice is in the DOM until asked.
 */
function TicketList({
  keys,
  ctx,
  initial = 8,
}: {
  keys: string[];
  ctx: TicketContext;
  initial?: number;
}) {
  if (keys.length === 0) return null;
  return (
    <div className="space-y-1">
      <CappedList items={keys} initial={initial} step={24} className="space-y-0.5" noun="ticket">
        {(k) => {
          const signal = ctx.signalByKey.get(k);
          const label = signal?.failureMode ?? ctx.summaryByKey.get(k) ?? "";
          return (
            <button
              key={k}
              type="button"
              onClick={() => ctx.onSelect(k)}
              className="w-full flex items-baseline gap-2 rounded px-2 py-0.5 -mx-2 text-left hover:bg-bg-muted/60 transition-colors"
            >
              <span className="font-mono text-[11px] text-accent shrink-0">{k}</span>
              <span className="text-[11px] text-fg-muted truncate">{label}</span>
              {signal?.isRegression && (
                <span className="text-[10px] text-warning shrink-0">regression</span>
              )}
            </button>
          );
        }}
      </CappedList>
      <JiraQueryLink keys={keys} jiraBaseUrl={ctx.jiraBaseUrl} />
    </div>
  );
}

/**
 * Renders the first `initial` items with a "show more" control. Generic so the
 * long lists in this report (tickets, hotspots, strategies) all cap the same way.
 */
function CappedList<T>({
  items,
  initial,
  step,
  className,
  noun,
  children,
}: {
  items: T[];
  initial: number;
  step?: number;
  className?: string;
  /** Singular noun used in the control's label, e.g. "ticket". */
  noun: string;
  children: (item: T, index: number) => React.ReactNode;
}) {
  const [limit, setLimit] = useState(initial);
  const shown = items.slice(0, limit);
  const remaining = items.length - shown.length;
  return (
    <>
      <div className={className}>{shown.map((item, i) => children(item, i))}</div>
      {(remaining > 0 || limit > initial) && (
        <div className="flex items-center gap-3 pt-1">
          {remaining > 0 && (
            <button
              type="button"
              onClick={() => setLimit((l) => l + (step ?? initial))}
              className="text-[11px] font-medium text-accent hover:text-accent-hover underline decoration-accent/40"
            >
              Show {Math.min(remaining, step ?? initial)} more {noun}
              {Math.min(remaining, step ?? initial) === 1 ? "" : "s"} ({remaining} left)
            </button>
          )}
          {limit > initial && (
            <button
              type="button"
              onClick={() => setLimit(initial)}
              className="text-[11px] text-fg-subtle hover:text-fg-muted underline decoration-border"
            >
              Show fewer
            </button>
          )}
        </div>
      )}
    </>
  );
}

function DistBars({
  title,
  items,
  total,
  barClass,
  max = 6,
}: {
  title: string;
  items: Array<{ label: string; count: number }>;
  total: number;
  barClass: string;
  max?: number;
}) {
  if (items.length === 0) return null;
  const shown = items.slice(0, max);
  const rest = items.slice(max).reduce((n, i) => n + i.count, 0);
  const denom = Math.max(1, total);
  return (
    <div className="space-y-1">
      <div className="text-[11px] uppercase tracking-wide text-fg-subtle">{title}</div>
      {shown.map((it) => (
        <div key={it.label} className="flex items-center gap-2">
          <span className="text-[11px] text-fg-muted w-40 shrink-0 truncate" title={it.label}>
            {it.label}
          </span>
          <span className="h-1.5 flex-1 rounded-full bg-bg-muted overflow-hidden">
            <span
              className={cn("block h-full rounded-full", barClass)}
              style={{ width: `${(it.count / denom) * 100}%` }}
            />
          </span>
          <span className="text-[11px] font-mono text-fg-subtle w-8 text-right">{it.count}</span>
        </div>
      ))}
      {rest > 0 && <div className="text-[10px] text-fg-subtle pl-[10.5rem]">+{rest} other</div>}
    </div>
  );
}

function Panel({
  title,
  icon,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded border border-border bg-bg-muted/30 px-3 py-2">
      <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-fg-subtle mb-1">
        {icon} {title}
      </div>
      <div className="text-xs">{children}</div>
    </div>
  );
}

function ChipRow({ label, values, mono }: { label: string; values: string[]; mono?: boolean }) {
  if (values.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-[11px] uppercase tracking-wide text-fg-subtle mr-1">{label}</span>
      {values.map((v) => (
        <Badge key={v} className={cn("border-border-strong normal-case", mono && "font-mono")}>
          {v}
        </Badge>
      ))}
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  className,
  children,
}: {
  active: boolean;
  onClick: () => void;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors",
        active
          ? "border-accent bg-accent/15 text-accent"
          : "border-border-strong bg-bg-muted text-fg-muted hover:text-fg",
        !active && className,
      )}
    >
      {children}
    </button>
  );
}

function LegendDot({ className, label }: { className: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={cn("inline-block h-1.5 w-3 rounded-sm", className)} />
      {label}
    </span>
  );
}

function ScorePill({ label, value }: { label: string; value: number }) {
  // 1-10 scales: 7+ is the "this hurts / this was avoidable" end.
  const tone = value >= 7 ? "text-danger" : value >= 4 ? "text-warning" : "text-fg-muted";
  return (
    <span className="text-[10px] uppercase tracking-wide text-fg-subtle">
      {label} <span className={cn("font-mono", tone)}>{value.toFixed(1)}</span>
    </span>
  );
}

function Stat({
  icon,
  label,
  value,
  tone,
  hint,
}: {
  icon: React.ReactNode;
  label: string;
  value: number | string;
  tone?: "danger" | "warning" | "success";
  hint?: string;
}) {
  const toneCls =
    tone === "danger"
      ? "text-danger"
      : tone === "warning"
        ? "text-warning"
        : tone === "success"
          ? "text-success"
          : "text-fg";
  return (
    <div className="rounded border border-border bg-bg-card px-4 py-3">
      <div className="flex items-center gap-2 text-[11px] uppercase tracking-wide text-fg-muted">
        {icon} {label}
      </div>
      <div className={cn("mt-1.5 text-2xl font-semibold", toneCls)}>{value}</div>
      {hint && <div className="text-[10px] text-fg-subtle mt-0.5">{hint}</div>}
    </div>
  );
}

function JiraQueryLink({
  keys,
  jiraBaseUrl,
  label,
}: {
  keys: string[];
  jiraBaseUrl: string;
  label?: string;
}) {
  const count = keys.length;
  if (count === 0) return null;
  const text = label ?? `View ${count} ticket${count === 1 ? "" : "s"} in JIRA`;
  if (!jiraBaseUrl) {
    return (
      <span className="text-[11px] text-fg-subtle">
        {count} ticket{count === 1 ? "" : "s"}
      </span>
    );
  }
  const jql = `key in (${keys.join(",")}) ORDER BY created DESC`;
  const href = `${jiraBaseUrl}/issues/?jql=${encodeURIComponent(jql)}`;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 text-[11px] font-medium text-accent hover:text-accent-hover underline decoration-accent/40 hover:decoration-accent"
    >
      {text}
      <ExternalLink className="h-3 w-3" />
    </a>
  );
}

function EmptyState({ loading }: { loading: boolean }) {
  return (
    <div className="flex-1 flex items-center justify-center p-12">
      <div className="max-w-md text-center space-y-3">
        <div className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-accent/15 border border-accent/30">
          <Bug className="h-5 w-5 text-accent" />
        </div>
        <h2 className="text-lg font-semibold">
          {loading ? "Loading…" : "No product defect analysis yet"}
        </h2>
        <p className="text-sm text-fg-muted">
          Configure the Product Defect Analysis JQL in <span className="text-fg">Settings</span>, then
          run <span className="text-fg">Sync &amp; Analyze</span> to pull every customer-found defect
          and build the taxonomy — defect groups, escape analysis, code correlation, prevention
          strategies and per-team plans.
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Metric math + formatting
// ---------------------------------------------------------------------------

type DeltaTone = "good" | "bad" | "flat" | "unknown";

const TONE_TEXT: Record<DeltaTone, string> = {
  good: "text-success",
  bad: "text-danger",
  flat: "text-fg-muted",
  unknown: "text-fg-subtle",
};

interface MetricDeltaResult {
  delta: number | null;
  pct: number | null;
  tone: DeltaTone;
}

/**
 * Current vs baseline, interpreted through the metric's own direction:
 * for `down-good` a NEGATIVE delta is the win, for `up-good` a positive one is.
 * Colour comes from the tone, never from the sign — a falling escape rate must
 * read green even though the number went down.
 */
function metricDelta(metric: DefectMetric): MetricDeltaResult {
  const { current, baseline, direction } = metric;
  if (current == null || baseline == null) return { delta: null, pct: null, tone: "unknown" };
  const delta = current - baseline;
  const pct = baseline === 0 ? null : (delta / Math.abs(baseline)) * 100;
  // "Flat" is relative to the metric's own scale: 0.4 on a baseline of 2 is a
  // 20% move and very much not flat, while 0.4 on a baseline of 400 is noise.
  const negligible = pct == null ? delta === 0 : Math.abs(pct) < 1;
  if (negligible) return { delta, pct, tone: "flat" };
  const improved = direction === "down-good" ? delta < 0 : delta > 0;
  return { delta, pct, tone: improved ? "good" : "bad" };
}

/** The delta as an arrow + number + percent. Arrow encodes the direction of the
 * MOVE; the color encodes whether that move is good. */
function DeltaLabel({ delta, unit }: { delta: MetricDeltaResult; unit: string }) {
  if (delta.delta == null) {
    return <span className="text-[11px] text-fg-subtle">no baseline</span>;
  }
  const Icon = delta.tone === "flat" ? Minus : delta.delta > 0 ? ArrowUp : ArrowDown;
  const sign = delta.delta > 0 ? "+" : "";
  return (
    <span className={cn("inline-flex items-center gap-0.5 font-mono text-[11px]", TONE_TEXT[delta.tone])}>
      <Icon className="h-3 w-3" aria-hidden="true" />
      {sign}
      {fmtValue(delta.delta, unit)}
      {delta.pct != null && Math.abs(delta.pct) >= 1 && (
        <span className="opacity-80">
          ({sign}
          {Math.round(delta.pct)}%)
        </span>
      )}
      <span className="sr-only">
        {delta.tone === "good" ? "improving" : delta.tone === "bad" ? "worsening" : "unchanged"}
      </span>
    </span>
  );
}

function fmtValue(v: number | null, unit: string): string {
  if (v == null) return "—";
  return unit === "%" ? `${fmtNumber(v)}%` : fmtNumber(v);
}

/** Compact number: enough precision to be honest, never more than 2 decimals. */
function fmtNumber(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 100) return v.toFixed(0);
  const fixed = abs >= 10 ? v.toFixed(1) : v.toFixed(2);
  return fixed.includes(".") ? fixed.replace(/\.?0+$/, "") : fixed;
}

function niceMax(v: number): number {
  if (v <= 1) return 1;
  if (v <= 5) return 5;
  if (v <= 10) return 10;
  const order = Math.pow(10, Math.floor(Math.log10(v)));
  const norm = v / order;
  const nice = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return nice * order;
}
