"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Markdown } from "@/components/markdown";
import { TicketDrawer } from "@/components/ticket-drawer";
import { cn } from "@/lib/utils";
import {
  Activity,
  AlertTriangle,
  ArrowDown,
  ArrowLeft,
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
  Info,
  Inbox,
  Layers,
  ListChecks,
  Minus,
  Radar,
  Radiation,
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
  type CodeHotspot,
  type ComponentAnalysis,
  type ComponentGroupSlice,
  type DefectGroup,
  type DefectMetric,
  type Effort,
  type MetricPoint,
  type PreventionDiscipline,
  type PreventionStrategy,
  type RootCause,
  type TeamCodeStats,
} from "@/types/product-defects";

/**
 * Response of `GET /api/product-defects/component/[slug]`.
 *
 * `groups` are the PARENT report's full groups for the keys this component
 * references — a `ComponentGroupSlice` carries counts only, so the analysis and
 * root causes a reader wants have to be joined in from here.
 */
interface ComponentResponse {
  component: ComponentAnalysis;
  groups: DefectGroup[];
  issues: JiraIssue[];
  jiraBaseUrl: string;
  /** Denominator behind `ComponentAnalysis.share`: the whole analyzed population. */
  analyzedTickets: number;
  /** Sum of every analyzed component's defectCount — exceeds `analyzedTickets`. */
  componentDefectSum: number;
  componentCount: number;
  /** `pdaComponentMinDefects`: the bar a component had to clear to get a page. */
  minDefects: number;
}

/** Same badge palettes the overall Product Defect Analysis view uses. */
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

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

export function ProductDefectComponentView({ slug }: { slug: string }) {
  const [data, setData] = useState<ComponentResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setData(null);
    fetch(`/api/product-defects/component/${encodeURIComponent(slug)}`)
      .then(async (r) => {
        const raw: unknown = await r.json();
        if (cancelled) return;
        if (!r.ok) {
          setError(
            isRecord(raw) && typeof raw.error === "string"
              ? raw.error
              : "This component has no analysis in the latest report.",
          );
          return;
        }
        setData(raw as ComponentResponse);
      })
      .catch(() => {
        if (!cancelled) setError("Could not load this component.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  /**
   * Ticket labels come from the cached issue summaries. The per-ticket
   * `DefectSignal`s (which carry the nicer `failureMode` the overall page shows)
   * live on the parent report and are deliberately not shipped here — sending
   * ~1300 signals to render a component's ticket list would defeat the point of
   * a scoped endpoint.
   */
  const summaryByKey = useMemo(
    () => new Map((data?.issues ?? []).map((i) => [i.key, i.summary])),
    [data],
  );
  const groupByKey = useMemo(
    () => new Map((data?.groups ?? []).map((g) => [g.key, g])),
    [data],
  );

  const ticketCtx: TicketContext = useMemo(
    () => ({ jiraBaseUrl: data?.jiraBaseUrl ?? "", onSelect: setSelected, summaryByKey }),
    [data?.jiraBaseUrl, summaryByKey],
  );

  // Narrowing on `data` rather than on a derived `component` keeps the rest of
  // the render able to read the population figures alongside the analysis.
  if (!data?.component) {
    return <MissingState loading={loading} error={error} slug={slug} />;
  }
  const component = data.component;

  /**
   * A component whose model call failed still has every deterministic section.
   * Saying so up front is better than a page that silently looks thin.
   */
  const narrativeMissing = !component.summary.trim() && !component.escapeAnalysis.trim();

  return (
    <div className="flex-1 overflow-auto scroll-thin">
      <header className="px-6 py-2.5 border-b border-border flex items-start justify-between gap-4 sticky top-0 z-10 bg-bg/90 backdrop-blur">
        <div className="min-w-0">
          <Link
            href="/product-defects"
            className="inline-flex items-center gap-1 text-[11px] text-fg-muted hover:text-fg transition-colors"
          >
            <ArrowLeft className="h-3 w-3" /> Product Defect Analysis — overall view
          </Link>
          <h1 className="text-lg font-semibold flex items-center gap-2">
            <Boxes className="h-4 w-4 text-accent" /> {component.component}
            <span className="text-[11px] font-normal font-mono text-fg-subtle">{component.slug}</span>
          </h1>
          <p className="text-[11px] text-fg-subtle">
            {component.defectCount.toLocaleString()} customer-found defects ·{" "}
            <span className="text-fg-muted">{component.share}%</span> of all{" "}
            {data.analyzedTickets.toLocaleString()} analyzed defects
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <JiraQueryLink
            keys={component.issueKeys}
            jiraBaseUrl={ticketCtx.jiraBaseUrl}
            label={`All ${component.defectCount} in JIRA`}
          />
        </div>
      </header>

      <div className="p-6 space-y-6">
        <ComponentTopLine component={component} analyzedTickets={data.analyzedTickets} />

        <PartitionNote
          componentCount={data.componentCount}
          componentDefectSum={data.componentDefectSum}
          analyzedTickets={data.analyzedTickets}
          minDefects={data.minDefects}
        />

        {narrativeMissing ? (
          <Card>
            <CardBody className="flex items-start gap-2 text-sm text-fg-muted">
              <AlertTriangle className="h-4 w-4 text-warning shrink-0 mt-0.5" />
              <span>
                The written narrative for {component.component} is unavailable — the analysis pass
                that produces it did not return text for this component. Every section below is
                computed directly from the defects and is unaffected.
              </span>
            </CardBody>
          </Card>
        ) : (
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-3 items-start">
            <NarrativeCard
              title={`What fails in ${component.component}`}
              icon={<Wrench className="h-4 w-4 text-accent" />}
              markdown={component.summary}
              missingNote="No written summary was produced for this component."
              jiraBaseUrl={ticketCtx.jiraBaseUrl}
            />
            <NarrativeCard
              title="Which gate keeps missing it"
              icon={<AlertTriangle className="h-4 w-4 text-warning" />}
              markdown={component.escapeAnalysis}
              missingNote="No written escape analysis was produced for this component."
              jiraBaseUrl={ticketCtx.jiraBaseUrl}
            />
          </div>
        )}

        <EscapeSignature component={component} />

        {(component.topAreas.length > 0 || component.topFailureModes.length > 0) && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Radiation className="h-4 w-4 text-warning" /> What it looks like on the ground
              </CardTitle>
            </CardHeader>
            <CardBody className="space-y-2">
              <ChipRow label="Product areas" values={component.topAreas.slice(0, 14)} />
              <ChipRow label="Failure modes" values={component.topFailureModes.slice(0, 14)} />
            </CardBody>
          </Card>
        )}

        <ComponentMetricsSection metrics={component.metrics} componentName={component.component} />

        <GroupSlicesSection
          component={component}
          groupByKey={groupByKey}
          ticketCtx={ticketCtx}
        />

        <ComponentStrategiesSection
          strategies={component.strategies}
          groupNameByKey={
            new Map(component.groups.map((g) => [g.groupKey, g.name] as const))
          }
          metricNameByKey={new Map(component.metrics.map((m) => [m.key, m.name] as const))}
        />

        <ComponentCodeSection component={component} ticketCtx={ticketCtx} />

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Inbox className="h-4 w-4 text-fg-subtle" /> Every defect tagged {component.component}
            </CardTitle>
            <Badge className="font-mono">{component.issueKeys.length}</Badge>
          </CardHeader>
          <CardBody>
            <TicketList keys={component.issueKeys} ctx={ticketCtx} initial={12} />
          </CardBody>
        </Card>
      </div>

      <TicketDrawer issueKey={selected} onClose={() => setSelected(null)} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header stats and the two share semantics
// ---------------------------------------------------------------------------

function ComponentTopLine({
  component,
  analyzedTickets,
}: {
  component: ComponentAnalysis;
  analyzedTickets: number;
}) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
      <Stat
        icon={<Inbox className="h-4 w-4" />}
        label="Defects"
        value={component.defectCount}
        hint={`${component.issueKeys.length} distinct tickets`}
      />
      <Stat
        icon={<Layers className="h-4 w-4 text-accent" />}
        // Spelled out because `ComponentGroupSlice.share` further down is a
        // share of THIS component — the two must never be read as the same axis.
        label="Share of all defects"
        value={`${component.share}%`}
        hint={`${component.defectCount} of ${analyzedTickets.toLocaleString()} analyzed`}
      />
      <Stat
        icon={<AlertTriangle className="h-4 w-4 text-warning" />}
        label="Regressions"
        value={component.regressionCount}
        tone="warning"
        hint={
          component.defectCount === 0
            ? undefined
            : `${Math.round((component.regressionCount / component.defectCount) * 100)}% of this component`
        }
      />
      <Stat
        icon={<Radiation className="h-4 w-4 text-danger" />}
        label="Avg severity"
        value={component.severityAvg.toFixed(1)}
        tone={component.severityAvg >= 7 ? "danger" : component.severityAvg >= 4 ? "warning" : undefined}
        hint="customer impact, 1-10"
      />
      <Stat
        icon={<ShieldCheck className="h-4 w-4 text-success" />}
        label="Avg preventability"
        value={component.preventabilityAvg.toFixed(1)}
        tone={
          component.preventabilityAvg >= 7
            ? "danger"
            : component.preventabilityAvg >= 4
              ? "warning"
              : undefined
        }
        hint="avoidable with better practice, 1-10"
      />
    </div>
  );
}

/**
 * JIRA components are tags. A defect carrying two of them appears under both, so
 * the per-component counts overlap and every "share of all defects" figure on
 * this page is a share, not a slice of a pie. A `ComponentAnalysis` records
 * neither the denominator behind its `share` nor the threshold it cleared, so
 * both are stated here — otherwise the handful of component pages read as if
 * they carve up the product between them.
 */
function PartitionNote({
  componentCount,
  componentDefectSum,
  analyzedTickets,
  minDefects,
}: {
  componentCount: number;
  componentDefectSum: number;
  analyzedTickets: number;
  minDefects: number;
}) {
  const overlapping = componentDefectSum > analyzedTickets;
  return (
    <div className="flex items-start gap-2 rounded border border-border bg-bg-muted/40 px-3 py-2 text-[11px] text-fg-muted">
      <Info className="h-3.5 w-3.5 text-fg-subtle shrink-0 mt-0.5" />
      <span>
        Components are tags, not a partition. The {componentCount} components with their own page
        carry <span className="font-mono text-fg-subtle">{componentDefectSum.toLocaleString()}</span>{" "}
        component tags across{" "}
        <span className="font-mono text-fg-subtle">{analyzedTickets.toLocaleString()}</span> analyzed
        defects
        {overlapping
          ? " — a defect tagged with two components is counted under both, so shares of the whole population overlap and never add up to 100%."
          : " — shares below are shares of the whole population, not slices of it."}{" "}
        Every &ldquo;share of all defects&rdquo; on this page is out of those{" "}
        {analyzedTickets.toLocaleString()}. Components with fewer than{" "}
        <span className="font-mono text-fg-subtle">{minDefects}</span> defects get no page of their
        own (the bar is set in{" "}
        <Link href="/settings" className="text-accent underline decoration-accent/40">
          Settings
        </Link>
        ); their defects still count in every total on the{" "}
        <Link href="/product-defects" className="text-accent underline decoration-accent/40">
          overall view
        </Link>
        .
      </span>
    </div>
  );
}

function NarrativeCard({
  title,
  icon,
  markdown,
  missingNote,
  jiraBaseUrl,
}: {
  title: string;
  icon: React.ReactNode;
  markdown: string;
  missingNote: string;
  jiraBaseUrl: string;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {icon} {title}
        </CardTitle>
      </CardHeader>
      <CardBody>
        {markdown.trim() ? (
          <Markdown jiraBaseUrl={jiraBaseUrl}>{markdown}</Markdown>
        ) : (
          <p className="text-xs text-fg-subtle">{missingNote}</p>
        )}
      </CardBody>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// The escape signature — the reason this page exists
// ---------------------------------------------------------------------------

/**
 * Detection stages and triggers, side by side and at full width. This is the
 * component's escape signature: the shape of these two distributions is what
 * distinguishes "Integrations leaks through integration tests" from "Graph
 * leaks through scale tests", and it is the whole argument for a per-component
 * page rather than a filter on the overall one. Hence the prominence.
 */
function EscapeSignature({ component }: { component: ComponentAnalysis }) {
  const topStage = component.detectionStages[0];
  const topTrigger = component.triggers[0];
  return (
    <section className="space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <Radar className="h-4 w-4 text-accent" />
        <h2 className="text-sm font-semibold">Escape signature</h2>
        <span className="text-xs text-fg-muted">
          how {component.component} defects get past us, and what sets them off
        </span>
      </div>

      {topStage && topTrigger && (
        <p className="text-xs text-fg-muted">
          Most of this component&rsquo;s escapes should have been caught at{" "}
          <span className="text-fg">{DETECTION_STAGE_LABELS[topStage.stage]}</span> (
          {topStage.count} defects), and the commonest trigger is{" "}
          <span className="text-fg">{TRIGGER_LABELS[topTrigger.trigger]}</span> ({topTrigger.count}
          ).
        </p>
      )}

      <Card>
        <CardBody className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <DistBars
            title="Earliest gate that should have caught it"
            items={component.detectionStages.map((d) => ({
              label: DETECTION_STAGE_LABELS[d.stage],
              count: d.count,
            }))}
            total={component.defectCount}
            barClass="bg-warning"
            max={10}
            size="lg"
          />
          <DistBars
            title="Condition that triggered it"
            items={component.triggers.map((t) => ({
              label: TRIGGER_LABELS[t.trigger],
              count: t.count,
            }))}
            total={component.defectCount}
            barClass="bg-accent"
            max={11}
            size="lg"
          />
        </CardBody>
      </Card>
      <p className="text-[10px] text-fg-subtle">
        Bars are percentages of this component&rsquo;s {component.defectCount} defects.
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Metrics — this component's own series
// ---------------------------------------------------------------------------

function ComponentMetricsSection({
  metrics,
  componentName,
}: {
  metrics: DefectMetric[];
  componentName: string;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const automated = useMemo(() => metrics.filter((m) => m.automated), [metrics]);
  const manual = useMemo(() => metrics.filter((m) => !m.automated), [metrics]);
  const open = automated.find((m) => m.key === expanded) ?? null;

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <Activity className="h-4 w-4 text-accent" />
        <h2 className="text-sm font-semibold">Success metrics — {componentName} only</h2>
        <span className="text-xs text-fg-muted">
          series recomputed over this component&rsquo;s defects
          {metrics.length > 0 &&
            ` · ${automated.length} automated${manual.length > 0 ? ` · ${manual.length} not instrumented yet` : ""}`}
        </span>
      </div>

      {metrics.length > 0 && (
        // Each metric's `definition` was authored for the whole population and is
        // reused verbatim per component, so a reader would otherwise take
        // report-wide wording as a claim about this component's scope.
        <p className="text-[11px] text-fg-subtle">
          Values and history below count only defects tagged {componentName}. Each metric&rsquo;s
          written definition is the report-wide one and is not re-worded per component.
        </p>
      )}

      {metrics.length === 0 ? (
        <Card>
          <CardBody className="text-fg-muted text-sm py-6 text-center">
            No metric series were computed for this component.
          </CardBody>
        </Card>
      ) : (
        <>
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
        </>
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
          className={cn(
            "h-3.5 w-3.5 text-fg-subtle transition-transform shrink-0",
            open ? "rotate-0" : "-rotate-90",
          )}
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
        {missing > 0 && (
          <span>
            {missing} period{missing === 1 ? "" : "s"} w/o data
          </span>
        )}
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
            className={cn(
              "h-3.5 w-3.5 text-fg-muted transition-transform shrink-0",
              open ? "rotate-0" : "-rotate-90",
            )}
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
              Target:{" "}
              <span className="font-mono text-fg-muted">{fmtValue(metric.target, metric.unit)}</span>
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Group slices — shares of THIS component
// ---------------------------------------------------------------------------

function GroupSlicesSection({
  component,
  groupByKey,
  ticketCtx,
}: {
  component: ComponentAnalysis;
  groupByKey: Map<string, DefectGroup>;
  ticketCtx: TicketContext;
}) {
  const slices = component.groups;
  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <Layers className="h-4 w-4 text-accent" />
        <h2 className="text-sm font-semibold">Defect groups in this component</h2>
        <span className="text-xs text-fg-muted">
          {slices.length} of the report&rsquo;s groups appear here · shares are of{" "}
          {component.component}&rsquo;s {component.defectCount} defects, not of the whole population
        </span>
      </div>
      {slices.length === 0 ? (
        <Card>
          <CardBody className="text-fg-muted text-sm py-6 text-center">
            None of the report&rsquo;s defect groups matched this component.
          </CardBody>
        </Card>
      ) : (
        <CappedList items={slices} initial={10} className="space-y-3" noun="group">
          {(s, i) => (
            <GroupSliceCard
              key={s.groupKey}
              slice={s}
              group={groupByKey.get(s.groupKey)}
              componentName={component.component}
              componentDefects={component.defectCount}
              defaultOpen={i === 0}
              ticketCtx={ticketCtx}
            />
          )}
        </CappedList>
      )}
    </section>
  );
}

function GroupSliceCard({
  slice,
  group,
  componentName,
  componentDefects,
  defaultOpen,
  ticketCtx,
}: {
  slice: ComponentGroupSlice;
  group?: DefectGroup;
  componentName: string;
  componentDefects: number;
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
            className={cn(
              "h-4 w-4 text-fg-muted transition-transform shrink-0",
              open ? "rotate-0" : "-rotate-90",
            )}
          />
          <div className="min-w-0">
            <h3 className="text-sm font-semibold truncate">{slice.name}</h3>
            <p className="text-[11px] text-fg-subtle truncate">
              {group?.description ?? "Group detail is not in this report."}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Badge className="border-accent/40 bg-accent/10 text-accent border font-mono normal-case">
            {slice.share}% of {componentName}
          </Badge>
          <span className="text-[11px] text-fg-subtle">
            <span className="text-fg-muted">{slice.ticketCount}</span> of {componentDefects}
          </span>
        </div>
      </button>

      {open && (
        <CardBody className="space-y-4">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <DistBars
              title={`Should have been caught at (in ${componentName})`}
              items={slice.detectionStages.map((d) => ({
                label: DETECTION_STAGE_LABELS[d.stage],
                count: d.count,
              }))}
              total={slice.ticketCount}
              barClass="bg-warning"
            />
            <DistBars
              title={`Triggered by (in ${componentName})`}
              items={slice.triggers.map((t) => ({
                label: TRIGGER_LABELS[t.trigger],
                count: t.count,
              }))}
              total={slice.ticketCount}
              barClass="bg-accent"
            />
          </div>

          {group ? (
            <>
              <div className="flex flex-wrap items-center gap-2 text-[11px] text-fg-subtle">
                <span className="uppercase tracking-wide">Group across the whole report</span>
                <Badge className="border-border-strong font-mono">
                  {group.ticketCount} defects · {group.share}% of all
                </Badge>
                {group.regressionCount > 0 && (
                  <Badge className="border border-warning/40 bg-warning/10 text-warning">
                    {group.regressionCount} regr
                  </Badge>
                )}
                <ScorePill label="sev" value={group.severityAvg} />
                <ScorePill label="prev" value={group.preventabilityAvg} />
              </div>

              {group.analysis && (
                <Panel title="What fails and why" icon={<Wrench className="h-3.5 w-3.5 text-accent" />}>
                  <Markdown jiraBaseUrl={ticketCtx.jiraBaseUrl}>{group.analysis}</Markdown>
                </Panel>
              )}
              {group.escapeAnalysis && (
                <Panel
                  title="Why it escaped us"
                  icon={<AlertTriangle className="h-3.5 w-3.5 text-warning" />}
                >
                  <Markdown jiraBaseUrl={ticketCtx.jiraBaseUrl}>{group.escapeAnalysis}</Markdown>
                </Panel>
              )}
              <RootCauseList causes={group.rootCauses} ticketCtx={ticketCtx} />
            </>
          ) : (
            <p className="text-xs text-fg-subtle">
              The parent report has no group with key{" "}
              <span className="font-mono">{slice.groupKey}</span>, so its analysis and root causes
              cannot be shown. The counts above are still this component&rsquo;s own.
            </p>
          )}

          <div className="pt-2 border-t border-border">
            <div className="text-[11px] uppercase tracking-wide text-fg-subtle mb-1">
              {componentName} tickets in this group ({slice.issueKeys.length})
            </div>
            <TicketList keys={slice.issueKeys} ctx={ticketCtx} />
          </div>
        </CardBody>
      )}
    </Card>
  );
}

function RootCauseList({ causes, ticketCtx }: { causes: RootCause[]; ticketCtx: TicketContext }) {
  if (causes.length === 0) return null;
  return (
    <div className="space-y-2">
      <div className="text-[11px] uppercase tracking-wide text-fg-subtle">
        Root causes ({causes.length})
      </div>
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
                label={`Evidence · ${rc.issueKeys.length} ticket${rc.issueKeys.length === 1 ? "" : "s"} in JIRA (whole report)`}
              />
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Strategies — same discipline grouping as the overall page
// ---------------------------------------------------------------------------

function ComponentStrategiesSection({
  strategies,
  groupNameByKey,
  metricNameByKey,
}: {
  strategies: PreventionStrategy[];
  groupNameByKey: Map<string, string>;
  metricNameByKey: Map<string, string>;
}) {
  const [priority, setPriority] = useState<ActionPriority | "all">("all");

  const filtered = useMemo(
    () => strategies.filter((s) => priority === "all" || s.priority === priority),
    [strategies, priority],
  );

  const byDiscipline = useMemo(() => {
    const map = new Map<PreventionDiscipline, PreventionStrategy[]>();
    for (const s of filtered) {
      const arr = map.get(s.discipline) ?? [];
      arr.push(s);
      map.set(s.discipline, arr);
    }
    // Fixed discipline order, "now" first inside each — this is a to-do list.
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
        <h2 className="text-sm font-semibold">Prevention strategies for this component</h2>
        <span className="text-xs text-fg-muted">
          {filtered.length} of {strategies.length} actions
        </span>
      </div>

      {strategies.length === 0 ? (
        <Card>
          <CardBody className="text-fg-muted text-sm py-6 text-center">
            No component-specific actions were produced. The report&rsquo;s{" "}
            <Link href="/product-defects" className="text-accent underline">
              overall prevention plan
            </Link>{" "}
            still applies.
          </CardBody>
        </Card>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-1.5">
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
        </>
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
// Code correlation, restricted to this component
// ---------------------------------------------------------------------------

function ComponentCodeSection({
  component,
  ticketCtx,
}: {
  component: ComponentAnalysis;
  ticketCtx: TicketContext;
}) {
  const cc = component.codeCorrelation;
  const teams = component.teams;

  if (!cc && teams.length === 0) {
    return (
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <Code2 className="h-4 w-4 text-accent" />
          <h2 className="text-sm font-semibold">Code correlation</h2>
        </div>
        <Card>
          <CardBody className="text-fg-muted text-sm py-6 text-center">
            No fix commits were correlated for this component.
          </CardBody>
        </Card>
      </section>
    );
  }

  const totalFixes = cc ? cc.fixesWithTests + cc.fixesWithoutTests : 0;
  const testedPct = totalFixes === 0 ? 0 : Math.round((cc?.fixesWithTests ?? 0) / totalFixes * 100);

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <Code2 className="h-4 w-4 text-accent" />
        <h2 className="text-sm font-semibold">Code correlation</h2>
        {cc && (
          <span className="text-xs text-fg-muted font-mono truncate">
            {cc.repoPath}
            {cc.repoHead && ` @ ${cc.repoHead.slice(0, 8)}`}
          </span>
        )}
      </div>

      {cc && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Stat
            icon={<GitCommitHorizontal className="h-4 w-4 text-accent" />}
            label="Link rate"
            value={`${Math.round(cc.linkRate)}%`}
            hint={`${cc.linkedTickets}/${cc.totalTickets} of this component's defects traced to a fix commit`}
          />
          <Stat
            icon={<FileCode2 className="h-4 w-4 text-warning" />}
            label="Hot files"
            value={cc.fileHotspots.length}
            tone="warning"
          />
          <Stat
            icon={<Users className="h-4 w-4 text-accent" />}
            label="Owning teams"
            value={teams.length || cc.byTeam.length}
          />
          <Stat
            icon={<FlaskConical className="h-4 w-4 text-success" />}
            label="Fixes with a test"
            value={totalFixes === 0 ? "—" : `${testedPct}%`}
            tone={totalFixes === 0 ? undefined : testedPct >= 50 ? "success" : "danger"}
            hint={`${cc.fixesWithTests} with · ${cc.fixesWithoutTests} without`}
          />
        </div>
      )}

      {cc && (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-3 items-start">
          <HotspotCard
            title="Hottest code areas"
            subtitle="Directories generating the most defects in this component"
            icon={<Boxes className="h-4 w-4 text-warning" />}
            hotspots={cc.areaHotspots}
            ticketCtx={ticketCtx}
          />
          <HotspotCard
            title="Hottest files"
            subtitle="Individual files fixed for the most distinct defects here"
            icon={<FileCode2 className="h-4 w-4 text-warning" />}
            hotspots={cc.fileHotspots}
            ticketCtx={ticketCtx}
          />
        </div>
      )}

      {teams.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Users className="h-4 w-4 text-accent" /> Teams owning this component&rsquo;s fixes
            </CardTitle>
            <Badge>{teams.length}</Badge>
          </CardHeader>
          <CardBody className="space-y-2">
            {/* `component.teams` duplicates `codeCorrelation.byTeam` by design;
                only this one is rendered so the page has a single team table. */}
            <p className="text-[11px] text-fg-subtle">
              &ldquo;Fixes w/ test&rdquo; is the share of the team&rsquo;s fix commits{" "}
              <em>in this component</em> that also changed a test file — the sharpest per-team signal
              on this page. It is left unrated below {MIN_COMMITS_FOR_RATE} commits, where one commit
              would swing it to 0% or 100%.
            </p>
            <div className="grid grid-cols-[minmax(0,1fr)_auto_auto_auto_9rem] gap-x-3 gap-y-1 items-center text-[11px]">
              <span className="uppercase tracking-wide text-fg-subtle">Team</span>
              <span className="uppercase tracking-wide text-fg-subtle text-right">Defects</span>
              <span className="uppercase tracking-wide text-fg-subtle text-right">Files</span>
              <span className="uppercase tracking-wide text-fg-subtle text-right">Commits</span>
              <span className="uppercase tracking-wide text-fg-subtle">Fixes w/ test</span>
              <CappedList items={teams} initial={10} className="contents" noun="team">
                {(t) => <TeamStatsRow key={t.team} stats={t} jiraBaseUrl={ticketCtx.jiraBaseUrl} />}
              </CappedList>
            </div>
          </CardBody>
        </Card>
      )}
    </section>
  );
}

/** Below this many fix commits a test-change rate is noise, not a signal. */
const MIN_COMMITS_FOR_RATE = 5;

function TeamStatsRow({ stats, jiraBaseUrl }: { stats: TeamCodeStats; jiraBaseUrl: string }) {
  // `testChangeRate` is documented as a "share" while its sibling `linkRate` is
  // documented as 0-100, so accept either rather than render a 0.34% bar.
  const pct = Math.round(stats.testChangeRate <= 1 ? stats.testChangeRate * 100 : stats.testChangeRate);
  const tone = pct >= 60 ? "bg-success" : pct >= 30 ? "bg-warning" : "bg-danger";
  /**
   * On a single component the per-team commit counts get small, and one commit
   * yields a confident-looking 0% or 100%. A bar that authoritative off one data
   * point is worse than admitting there isn't enough evidence, so below the
   * threshold the rate is shown as bare text with its sample size and no bar.
   */
  const tooFewCommits = stats.commitCount < MIN_COMMITS_FOR_RATE;
  return (
    <>
      <span className="font-mono text-fg truncate" title={stats.team}>
        {stats.team}
      </span>
      <span className="font-mono text-right text-fg-muted">
        <JiraQueryLink
          keys={stats.issueKeys}
          jiraBaseUrl={jiraBaseUrl}
          label={String(stats.defectCount)}
        />
      </span>
      <span className="font-mono text-right text-fg-subtle">{stats.fileCount}</span>
      <span className="font-mono text-right text-fg-subtle">{stats.commitCount}</span>
      {tooFewCommits ? (
        <span className="text-fg-subtle" title={`Only ${stats.commitCount} linked fix commit${stats.commitCount === 1 ? "" : "s"} here — too few to rate`}>
          too few commits{" "}
          <span className="font-mono opacity-70">
            ({pct}% of {stats.commitCount})
          </span>
        </span>
      ) : (
        <span className="flex items-center gap-1.5">
          <span className="h-1.5 flex-1 rounded-full bg-bg-muted overflow-hidden">
            <span className={cn("block h-full rounded-full", tone)} style={{ width: `${pct}%` }} />
          </span>
          <span className="font-mono text-fg-subtle w-8 text-right">{pct}%</span>
        </span>
      )}
    </>
  );
}

/**
 * Hot paths, split on `existsAtHead`.
 *
 * Hotspots are derived from historical fix commits, so a path may since have
 * been moved or deleted. Those are kept visible as evidence but pulled out of
 * the main list and never framed as somewhere to go and add tests — pointing a
 * team at a file that no longer exists burns their trust in the whole report.
 */
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
  const live = hotspots.filter((h) => h.existsAtHead !== false);
  const gone = hotspots.filter((h) => h.existsAtHead === false);
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
          <>
            {live.length === 0 ? (
              <p className="text-sm text-fg-muted">
                Every hot path here has since moved or been deleted — nothing to target.
              </p>
            ) : (
              <CappedList items={live} initial={8} className="space-y-1.5" noun="path">
                {(h) => <HotspotRow key={h.path} hotspot={h} max={max} ticketCtx={ticketCtx} />}
              </CappedList>
            )}
            {gone.length > 0 && (
              <div className="pt-2 border-t border-border space-y-1.5">
                <div className="text-[11px] uppercase tracking-wide text-fg-subtle">
                  No longer at HEAD — history only, not remediation targets ({gone.length})
                </div>
                <CappedList items={gone} initial={4} className="space-y-1.5" noun="path">
                  {(h) => (
                    <HotspotRow key={h.path} hotspot={h} max={max} ticketCtx={ticketCtx} stale />
                  )}
                </CappedList>
              </div>
            )}
          </>
        )}
      </CardBody>
    </Card>
  );
}

function HotspotRow({
  hotspot,
  max,
  ticketCtx,
  stale,
}: {
  hotspot: CodeHotspot;
  max: number;
  ticketCtx: TicketContext;
  stale?: boolean;
}) {
  return (
    <div className={cn("space-y-0.5", stale && "opacity-70")}>
      <div className="flex items-center justify-between gap-2">
        <span
          className={cn(
            "font-mono text-[11px] truncate",
            stale ? "text-fg-subtle line-through decoration-fg-subtle/50" : "text-fg",
          )}
          title={hotspot.path}
        >
          {hotspot.path}
        </span>
        <span className="shrink-0 flex items-center gap-2">
          {stale && <Badge className="border-border-strong normal-case">gone</Badge>}
          {hotspot.fileCount > 1 && (
            <span className="text-[10px] text-fg-subtle">{hotspot.fileCount} files</span>
          )}
          <JiraQueryLink
            keys={hotspot.issueKeys}
            jiraBaseUrl={ticketCtx.jiraBaseUrl}
            label={`${hotspot.defectCount} defects`}
          />
        </span>
      </div>
      <div className="h-1.5 w-full rounded-full bg-bg-muted overflow-hidden">
        <div
          className={cn("h-full rounded-full", stale ? "bg-fg-subtle/50" : "bg-warning")}
          style={{ width: `${max === 0 ? 0 : (hotspot.defectCount / max) * 100}%` }}
        />
      </div>
      {hotspot.teams.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {hotspot.teams.slice(0, 3).map((t) => (
            <span key={t} className="text-[10px] font-mono text-fg-subtle">
              {t}
            </span>
          ))}
          {hotspot.teams.length > 3 && (
            <span className="text-[10px] text-fg-subtle">+{hotspot.teams.length - 3}</span>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared pieces — duplicated from the overall view on purpose: that file is a
// sibling page, not a component library, and extracting a shared kit would mean
// editing it while it is being changed elsewhere.
// ---------------------------------------------------------------------------

interface TicketContext {
  jiraBaseUrl: string;
  onSelect: (key: string) => void;
  summaryByKey: Map<string, string>;
}

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
        {(k) => (
          <button
            key={k}
            type="button"
            onClick={() => ctx.onSelect(k)}
            className="w-full flex items-baseline gap-2 rounded px-2 py-0.5 -mx-2 text-left hover:bg-bg-muted/60 transition-colors"
          >
            <span className="font-mono text-[11px] text-accent shrink-0">{k}</span>
            <span className="text-[11px] text-fg-muted truncate">{ctx.summaryByKey.get(k) ?? ""}</span>
          </button>
        )}
      </CappedList>
      <JiraQueryLink keys={keys} jiraBaseUrl={ctx.jiraBaseUrl} />
    </div>
  );
}

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
  size = "sm",
}: {
  title: string;
  items: Array<{ label: string; count: number }>;
  total: number;
  barClass: string;
  max?: number;
  /** "lg" is used for the escape signature, which is this page's headline. */
  size?: "sm" | "lg";
}) {
  if (items.length === 0) {
    return (
      <div className="space-y-1">
        <div className="text-[11px] uppercase tracking-wide text-fg-subtle">{title}</div>
        <p className="text-xs text-fg-subtle">No distribution was computed.</p>
      </div>
    );
  }
  const shown = items.slice(0, max);
  const rest = items.slice(max).reduce((n, i) => n + i.count, 0);
  const denom = Math.max(1, total);
  const lg = size === "lg";
  return (
    <div className={lg ? "space-y-1.5" : "space-y-1"}>
      <div className="text-[11px] uppercase tracking-wide text-fg-subtle">{title}</div>
      {shown.map((it) => {
        const pct = (it.count / denom) * 100;
        return (
          <div key={it.label} className="flex items-center gap-2">
            <span
              className={cn("text-fg-muted shrink-0 truncate", lg ? "text-xs w-44" : "text-[11px] w-40")}
              title={it.label}
            >
              {it.label}
            </span>
            <span
              className={cn(
                "flex-1 rounded-full bg-bg-muted overflow-hidden",
                lg ? "h-2.5" : "h-1.5",
              )}
            >
              <span
                className={cn("block h-full rounded-full", barClass)}
                style={{ width: `${pct}%` }}
              />
            </span>
            <span
              className={cn(
                "font-mono text-fg-subtle text-right shrink-0",
                lg ? "text-[11px] w-16" : "text-[11px] w-8",
              )}
            >
              {it.count}
              {lg && <span className="text-fg-subtle/70"> · {Math.round(pct)}%</span>}
            </span>
          </div>
        );
      })}
      {rest > 0 && (
        <div className={cn("text-[10px] text-fg-subtle", lg ? "pl-[11.5rem]" : "pl-[10.5rem]")}>
          +{rest} other
        </div>
      )}
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

function MissingState({
  loading,
  error,
  slug,
}: {
  loading: boolean;
  error: string | null;
  slug: string;
}) {
  return (
    <div className="flex-1 flex items-center justify-center p-12">
      <div className="max-w-md text-center space-y-3">
        <div className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-accent/15 border border-accent/30">
          <Bug className="h-5 w-5 text-accent" />
        </div>
        <h2 className="text-lg font-semibold">
          {loading ? "Loading…" : "No analysis for this component"}
        </h2>
        {!loading && (
          <>
            <p className="text-sm text-fg-muted">
              {error ?? (
                <>
                  Nothing in the latest report matches{" "}
                  <span className="font-mono text-fg">{slug}</span>.
                </>
              )}
            </p>
            <p className="text-xs text-fg-subtle">
              Only components clearing the configured minimum defect count get their own analysis.
            </p>
            <Link
              href="/product-defects"
              className="inline-flex items-center gap-1 text-sm text-accent hover:text-accent-hover underline decoration-accent/40"
            >
              <ArrowLeft className="h-3.5 w-3.5" /> Back to Product Defect Analysis
            </Link>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Metric math, charts and formatting
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

const SPARK_W = 160;

interface SparkGeometry {
  segments: string[];
  /** Isolated points (a real value with nulls on both sides) drawn as dots. */
  dots: Array<{ x: number; y: number }>;
  last: { x: number; y: number };
}

/**
 * Sparkline over a metric's series. Each contiguous run of real values is its
 * own path, so a null period stays a visible gap instead of being interpolated
 * through — or, worse, read as a zero.
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
    return (
      <div className="mt-2 h-[30px] text-[10px] text-fg-subtle flex items-end">
        not enough history
      </div>
    );
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
      segments.push(
        run.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" "),
      );
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
 * The expanded, axis-labeled version of the tile sparkline: same gap handling,
 * plus y ticks in the metric's unit, period labels and baseline/target rules.
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
        segments.push(
          run.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" "),
        );
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
        <svg
          viewBox={`0 0 ${CHART_W} ${CHART_H}`}
          className="w-full h-auto"
          role="img"
          aria-label={`${metric.name} by ${metric.cadence} period, in ${metric.unit}`}
        >
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
