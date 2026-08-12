import type { JiraIssue, Priority } from "@/types/triage";
import type {
  CodeCorrelation,
  DefectMetric,
  DefectSignal,
  DetectionStage,
  MetricPoint,
} from "@/types/product-defects";
import { DETECTION_STAGE_LABELS } from "@/types/product-defects";
import { priorityFromString } from "./priority";

/**
 * Success metrics for the Product Defect Analysis dashboard.
 *
 * Everything here is PURE and deterministic given `now`: no clock reads inside
 * the helpers, no db, no network. The runner calls this twice per sync (once
 * before the model phases with only ticket history + code correlation, once
 * after with signals and groups), so every metric that needs an input it wasn't
 * given degrades to a non-automated placeholder rather than disappearing.
 *
 * The point of this module is BACKFILL. Every ticket carries `created` and
 * `resolved`, so most of these metrics have a real monthly history from day one
 * instead of starting at a single dot. Leadership can see whether prevention
 * work is bending the curve on the first run.
 *
 * Conventions, applied uniformly:
 *  - Months are UTC "YYYY-MM" buckets. The window is inclusive of the current,
 *    still-incomplete month.
 *  - `current` is the last COMPLETE month — never the partial one, which would
 *    always look like a fake drop. The partial month is still emitted in
 *    `series` so charts stay fresh.
 *  - `baseline` is the mean of the complete months BEFORE the one reported as
 *    `current`, so current-vs-baseline is a real comparison.
 *  - Null means "we cannot know", zero means "we know it was zero". A period
 *    outside the data's coverage, or a ratio with an empty denominator, is null.
 *  - Percentages are 0-100 with one decimal; day counts have one decimal.
 */

export const DEFAULT_MONTHS = 13;

const DAY_MS = 86_400_000;
/** A defect is "aging" once it has been open strictly longer than this. */
export const AGING_THRESHOLD_DAYS = 90;
/** Edits later than this after resolution are treated as possible rework. */
export const REOPEN_SLACK_DAYS = 7;
/** A comment this close to the last edit is assumed to BE the edit. */
const COMMENT_EXPLAINS_UPDATE_DAYS = 1;
const TOP_GROUP_COUNT = 3;
const TOP_HOTSPOT_COUNT = 10;
const TOP_ESCAPE_STAGE_COUNT = 3;

const CONVENTIONS =
  "Monthly buckets in UTC. The final point is the current, still-incomplete month — it is flagged `partial` and charted for freshness, but excluded from both `current` (which reports the last complete month) and `baseline` (the mean of the complete months before it). Periods with nothing to divide by are null, not zero.";

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Parse an ISO timestamp to epoch ms, or null when absent/unparseable. */
export function parseMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/** UTC "YYYY-MM" for a Date, ISO string or epoch ms. Empty string if invalid. */
export function monthKey(value: Date | string | number): string {
  const d =
    value instanceof Date ? value : typeof value === "number" ? new Date(value) : new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`;
}

/**
 * The `months` UTC month keys ending at (and including) the month of `now`,
 * oldest first. Crossing a year boundary is handled by Date.UTC's normalization
 * of out-of-range month indices.
 */
export function monthsBack(now: Date, months: number): string[] {
  const n = Math.max(1, Math.floor(months));
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) out.push(monthKey(new Date(Date.UTC(y, m - i, 1))));
  return out;
}

/** First instant of a "YYYY-MM" period, in epoch ms. */
export function monthStartMs(period: string): number {
  const [y, m] = period.split("-").map(Number);
  return Date.UTC(y, m - 1, 1, 0, 0, 0, 0);
}

/** Last instant of a "YYYY-MM" period (T23:59:59.999Z), in epoch ms. */
export function monthEndMs(period: string): number {
  const [y, m] = period.split("-").map(Number);
  return Date.UTC(y, m, 1, 0, 0, 0, 0) - 1;
}

/** Bucket items by the UTC month of a date accessor. Undated items are dropped. */
export function bucketByMonth<T>(
  items: T[],
  dateOf: (item: T) => string | number | null | undefined,
): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const raw = dateOf(item);
    if (raw === null || raw === undefined || raw === "") continue;
    const key = monthKey(raw);
    if (!key) continue;
    const arr = out.get(key);
    if (arr) arr.push(item);
    else out.set(key, [item]);
  }
  return out;
}

/** Arithmetic mean, or null for an empty set. */
export function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Median (mean of the middle pair when even), or null for an empty set. */
export function median(values: number[]): number | null {
  return percentile(values, 50);
}

/**
 * Linear-interpolated percentile, `p` in 0-100. p=50 is the median (mean of the
 * middle pair on an even-sized set). Null for an empty set.
 */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const clamped = Math.min(100, Math.max(0, p));
  const rank = ((sorted.length - 1) * clamped) / 100;
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
}

/** Round to one decimal place, half away from zero. */
export function round1(n: number): number {
  const sign = n < 0 ? -1 : 1;
  return (sign * Math.round(Math.abs(n) * 10 + Number.EPSILON)) / 10;
}

/** `numerator / denominator` as a 0-100 percentage with one decimal; null on an empty denominator. */
export function pctOf(numerator: number, denominator: number): number | null {
  if (!denominator || denominator <= 0) return null;
  return round1((numerator / denominator) * 100);
}

/** True when `issue` was open at `atMs`: created on/before it and not yet resolved by then. */
export function openAt(createdMs: number, resolvedMs: number | null, atMs: number): boolean {
  if (!(createdMs <= atMs)) return false;
  if (resolvedMs === null) return true;
  return resolvedMs > atMs;
}

// ---------------------------------------------------------------------------
// Internal record shape — dates parsed once
// ---------------------------------------------------------------------------

interface DefectRecord {
  key: string;
  createdMs: number;
  resolvedMs: number | null;
  updatedMs: number | null;
  lastCommentMs: number | null;
  statusCategory: JiraIssue["statusCategory"];
  priority: Priority | null;
}

function toRecords(issues: JiraIssue[]): DefectRecord[] {
  const out: DefectRecord[] = [];
  for (const issue of issues) {
    const createdMs = parseMs(issue.created);
    if (createdMs === null) continue; // undated ticket: cannot be placed in time
    let lastCommentMs: number | null = null;
    for (const c of issue.comments ?? []) {
      const ms = parseMs(c.created);
      if (ms !== null && (lastCommentMs === null || ms > lastCommentMs)) lastCommentMs = ms;
    }
    out.push({
      key: issue.key,
      createdMs,
      resolvedMs: parseMs(issue.resolved),
      updatedMs: parseMs(issue.updated),
      lastCommentMs,
      statusCategory: issue.statusCategory,
      priority: priorityFromString(issue.priority),
    });
  }
  return out;
}

/**
 * Churn / reopen PROXY. See the metric definition for the honest caveat: we
 * sync JIRA fields, not changelogs, so this infers rework rather than counting
 * it. Two signals:
 *   (a) the ticket has a resolution date but is no longer in the Done category
 *       — something moved it back out; strong evidence of a reopen.
 *   (b) it was edited more than REOPEN_SLACK_DAYS after resolution, and that
 *       edit is not explained by a comment posted around the same time (a
 *       trailing "any update?" comment bumps `updated` without being rework).
 */
export function looksReworked(rec: DefectRecord): boolean {
  if (rec.resolvedMs === null) return false;
  if (rec.statusCategory !== "done") return true;
  if (rec.updatedMs === null) return false;
  const lateBy = rec.updatedMs - rec.resolvedMs;
  if (lateBy <= REOPEN_SLACK_DAYS * DAY_MS) return false;
  if (
    rec.lastCommentMs !== null &&
    rec.lastCommentMs >= rec.updatedMs - COMMENT_EXPLAINS_UPDATE_DAYS * DAY_MS
  ) {
    return false; // the late edit was (almost certainly) just a comment
  }
  return true;
}

// ---------------------------------------------------------------------------
// Metric assembly
// ---------------------------------------------------------------------------

interface PeriodContext {
  period: string;
  /** First instant of the month. */
  startMs: number;
  /** Last instant of the month, clamped to `now` for the partial month. */
  endMs: number;
  isPartial: boolean;
  /** False for periods before the earliest ticket we have — those emit null. */
  inCoverage: boolean;
}

type PointFn = (ctx: PeriodContext) => Omit<MetricPoint, "period">;

function buildSeries(contexts: PeriodContext[], point: PointFn): MetricPoint[] {
  return contexts.map((ctx) => {
    const p: MetricPoint = { period: ctx.period, ...point(ctx) };
    // Only the in-progress period is flagged; complete periods leave the field
    // unset rather than carrying `false`, to keep the stored series small.
    if (ctx.isPartial) p.partial = true;
    return p;
  });
}

type MetricSpec = Omit<DefectMetric, "current" | "baseline">;

/**
 * Fill in `current` and `baseline` from the series, honouring the partial-month
 * convention: the last point is the incomplete month and is never `current`.
 */
function withStats(spec: MetricSpec): DefectMetric {
  const { series } = spec;
  const complete = series.slice(0, Math.max(0, series.length - 1));
  const current = complete.length ? complete[complete.length - 1].value : null;
  const priorValues = complete
    .slice(0, Math.max(0, complete.length - 1))
    .map((p) => p.value)
    .filter((v): v is number => v !== null);
  const baselineRaw = mean(priorValues);
  return {
    ...spec,
    current,
    baseline: baselineRaw === null ? null : round1(baselineRaw),
  };
}

/** A metric this dashboard cannot compute with the inputs it was given. */
function placeholder(
  spec: Omit<DefectMetric, "current" | "baseline" | "series" | "automated">,
): DefectMetric {
  return { ...spec, automated: false, series: [], current: null, baseline: null };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ComputeMetricsOptions {
  /** Injectable clock, for deterministic tests. Defaults to the real now. */
  now?: Date;
  /** History depth in months, inclusive of the current partial month. */
  months?: number;
  /** Per-ticket AI signals; unlock the escape/preventability/regression metrics. */
  signals?: DefectSignal[];
  /** Git + CODEOWNERS correlation; unlocks the code-side metrics. */
  correlation?: CodeCorrelation | null;
  /** Defect taxonomy; unlocks the concentration metric. */
  groups?: Array<{ key: string; name: string; issueKeys: string[] }>;
}

export function computeDefectMetrics(
  issues: JiraIssue[],
  opts: ComputeMetricsOptions = {},
): DefectMetric[] {
  const now = opts.now ?? new Date();
  const nowMs = now.getTime();
  const months = Math.max(1, Math.floor(opts.months ?? DEFAULT_MONTHS));
  const periods = monthsBack(now, months);

  const records = toRecords(issues);
  const byKey = new Map(records.map((r) => [r.key, r]));

  // Coverage: months before the earliest ticket are unknowable, not empty.
  let coverageStart: string | null = null;
  for (const r of records) {
    const k = monthKey(r.createdMs);
    if (!coverageStart || k < coverageStart) coverageStart = k;
  }

  const contexts: PeriodContext[] = periods.map((period) => {
    const trueEnd = monthEndMs(period);
    return {
      period,
      startMs: monthStartMs(period),
      endMs: Math.min(trueEnd, nowMs),
      isPartial: trueEnd > nowMs,
      inCoverage: coverageStart !== null && period >= coverageStart,
    };
  });

  const byCreatedMonth = bucketByMonth(records, (r) => r.createdMs);
  const byResolvedMonth = bucketByMonth(records, (r) => r.resolvedMs);

  const metrics: DefectMetric[] = [
    inflowMetric(contexts, byCreatedMonth),
    backlogMetric(contexts, records),
    ...timeToResolveMetrics(contexts, byResolvedMonth),
    priorityShareMetric(contexts, byCreatedMonth),
    agingMetric(contexts, records),
    churnMetric(contexts, byResolvedMonth),
    concentrationMetric(contexts, byCreatedMonth, opts.groups),
    ...escapeStageMetrics(contexts, byKey, opts.signals),
    preventabilityMetric(contexts, byKey, opts.signals),
    regressionMetric(contexts, byKey, opts.signals),
    fixWithTestMetric(contexts, opts.correlation ?? null),
    hotspotConcentrationMetric(contexts, byKey, opts.correlation ?? null),
    ...proposedMetrics(),
  ];

  return metrics;
}

// ---------------------------------------------------------------------------
// 1. Inflow
// ---------------------------------------------------------------------------

function inflowMetric(
  contexts: PeriodContext[],
  byCreatedMonth: Map<string, DefectRecord[]>,
): DefectMetric {
  return withStats({
    key: "customer-defect-inflow",
    name: "Customer-found defect inflow",
    definition: `How many customer-found defects were filed each month (bucketed by the ticket's creation date). This is the raw rate at which customers are hitting bugs; every prevention strategy is ultimately trying to bend this line down. ${CONVENTIONS}`,
    unit: "defects/month",
    direction: "down-good",
    source: "jira",
    automated: true,
    target: null,
    cadence: "monthly",
    series: buildSeries(contexts, (ctx) => {
      if (!ctx.inCoverage) return { value: null };
      return { value: byCreatedMonth.get(ctx.period)?.length ?? 0 };
    }),
    howToMeasure:
      "Computed from the JIRA population directly: count of tickets whose `created` falls in the month.",
    relatedGroupKeys: [],
  });
}

// ---------------------------------------------------------------------------
// 2. Point-in-time open backlog
// ---------------------------------------------------------------------------

function backlogMetric(contexts: PeriodContext[], records: DefectRecord[]): DefectMetric {
  return withStats({
    key: "open-customer-defect-backlog",
    name: "Open customer defect backlog",
    definition: `How many customer-found defects were still unresolved at the end of each month. This is a true point-in-time reconstruction — a defect counts for month M if it was created on or before the end of M and was either still unresolved or resolved after M ended — not a snapshot of today's open list projected backwards. Rising backlog with flat inflow means we are resolving slower than customers are reporting. ${CONVENTIONS}`,
    unit: "defects",
    direction: "down-good",
    source: "jira",
    automated: true,
    target: null,
    cadence: "monthly",
    series: buildSeries(contexts, (ctx) => {
      if (!ctx.inCoverage) return { value: null };
      let open = 0;
      for (const r of records) if (openAt(r.createdMs, r.resolvedMs, ctx.endMs)) open++;
      return { value: open };
    }),
    howToMeasure:
      "Computed from `created`/`resolved` on every ticket in the population; no snapshot storage required.",
    relatedGroupKeys: [],
  });
}

// ---------------------------------------------------------------------------
// 3. Time to resolve (mean and median)
// ---------------------------------------------------------------------------

function timeToResolveMetrics(
  contexts: PeriodContext[],
  byResolvedMonth: Map<string, DefectRecord[]>,
): DefectMetric[] {
  const daysFor = (period: string): number[] =>
    (byResolvedMonth.get(period) ?? []).map(
      (r) => ((r.resolvedMs as number) - r.createdMs) / DAY_MS,
    );

  const shared = `Bucketed by the month the defect was RESOLVED (not filed), so the number answers "how long did the things we closed this month take?". ${CONVENTIONS}`;

  const meanMetric = withStats({
    key: "time-to-resolve-mean",
    name: "Mean time to resolve",
    definition: `Average calendar days from ticket creation to resolution. Sensitive to a handful of very old tickets finally being closed — read it alongside the median. ${shared}`,
    unit: "days",
    direction: "down-good",
    source: "jira",
    automated: true,
    target: null,
    cadence: "monthly",
    series: buildSeries(contexts, (ctx) => {
      const days = daysFor(ctx.period);
      const m = mean(days);
      return { value: m === null ? null : round1(m), denominator: days.length };
    }),
    howToMeasure: "Computed from `created` and `resolutiondate` on each resolved ticket.",
    relatedGroupKeys: [],
  });

  const medianMetric = withStats({
    key: "time-to-resolve-median",
    name: "Median time to resolve",
    definition: `Median calendar days from ticket creation to resolution — the typical customer's wait, unmoved by a few extreme outliers. A median well below the mean means a long tail of stale defects is being cleared. ${shared}`,
    unit: "days",
    direction: "down-good",
    source: "jira",
    automated: true,
    target: null,
    cadence: "monthly",
    series: buildSeries(contexts, (ctx) => {
      const days = daysFor(ctx.period);
      const m = median(days);
      return { value: m === null ? null : round1(m), denominator: days.length };
    }),
    howToMeasure: "Computed from `created` and `resolutiondate` on each resolved ticket.",
    relatedGroupKeys: [],
  });

  return [meanMetric, medianMetric];
}

// ---------------------------------------------------------------------------
// 4. P0/P1 share
// ---------------------------------------------------------------------------

function priorityShareMetric(
  contexts: PeriodContext[],
  byCreatedMonth: Map<string, DefectRecord[]>,
): DefectMetric {
  return withStats({
    key: "p0-p1-share",
    name: "P0/P1 share of customer-found defects",
    definition: `Of the customer-found defects filed in a month, the percentage that were P0 or P1 (using the ticket's current priority, including JIRA's Highest/Critical/High aliases). This is a severity-mix metric: total inflow can hold steady while the damage each defect does gets worse. ${CONVENTIONS}`,
    unit: "%",
    direction: "down-good",
    source: "jira",
    automated: true,
    target: null,
    cadence: "monthly",
    series: buildSeries(contexts, (ctx) => {
      const recs = byCreatedMonth.get(ctx.period) ?? [];
      const hot = recs.filter((r) => r.priority === "P0" || r.priority === "P1").length;
      return { value: pctOf(hot, recs.length), numerator: hot, denominator: recs.length };
    }),
    howToMeasure:
      "Computed from the ticket's priority field. Note this is the CURRENT priority — JIRA does not cheaply expose the priority as of the filing date, so re-prioritized tickets are counted at their latest level.",
    relatedGroupKeys: [],
  });
}

// ---------------------------------------------------------------------------
// 5. Aging
// ---------------------------------------------------------------------------

function agingMetric(contexts: PeriodContext[], records: DefectRecord[]): DefectMetric {
  return withStats({
    key: "aging-over-90d-share",
    name: `Share of open defects older than ${AGING_THRESHOLD_DAYS} days`,
    definition: `Of the customer-found defects still open at the end of a month, the percentage that had been open for strictly more than ${AGING_THRESHOLD_DAYS} days at that moment. A backlog that is merely large is a capacity problem; a backlog that is old is a credibility problem with customers. ${CONVENTIONS}`,
    unit: "%",
    direction: "down-good",
    source: "jira",
    automated: true,
    target: null,
    cadence: "monthly",
    series: buildSeries(contexts, (ctx) => {
      if (!ctx.inCoverage) return { value: null };
      let open = 0;
      let aged = 0;
      for (const r of records) {
        if (!openAt(r.createdMs, r.resolvedMs, ctx.endMs)) continue;
        open++;
        if ((ctx.endMs - r.createdMs) / DAY_MS > AGING_THRESHOLD_DAYS) aged++;
      }
      return { value: pctOf(aged, open), numerator: aged, denominator: open };
    }),
    howToMeasure:
      "Computed point-in-time from `created`/`resolved`: age at period end, evaluated only over the tickets open at that instant.",
    relatedGroupKeys: [],
  });
}

// ---------------------------------------------------------------------------
// 6. Reopen / churn proxy
// ---------------------------------------------------------------------------

function churnMetric(
  contexts: PeriodContext[],
  byResolvedMonth: Map<string, DefectRecord[]>,
): DefectMetric {
  return withStats({
    key: "reopen-churn-rate",
    name: "Reopen / rework rate (proxy)",
    definition: `APPROXIMATION — read the method before quoting this number. Of the defects resolved in a month, the percentage whose subsequent history suggests the fix did not hold. This tool syncs JIRA issue fields, not issue changelogs, so a true reopen count is not available; instead a defect is counted when either (a) it carries a resolution date but its status is no longer in the Done category, meaning something moved it back out of resolved, or (b) it was edited more than ${REOPEN_SLACK_DAYS} days after being resolved and that edit is not explained by a comment posted within a day of it. Signal (a) is strong; signal (b) is a heuristic that will over-count field edits and under-count reopens that were later re-closed. Treat this as directional until changelog sync exists. ${CONVENTIONS}`,
    unit: "%",
    direction: "down-good",
    source: "jira",
    automated: true,
    target: null,
    cadence: "monthly",
    series: buildSeries(contexts, (ctx) => {
      const recs = byResolvedMonth.get(ctx.period) ?? [];
      const churned = recs.filter(looksReworked).length;
      return { value: pctOf(churned, recs.length), numerator: churned, denominator: recs.length };
    }),
    howToMeasure:
      "To measure this exactly, sync the JIRA changelog and count status transitions OUT of the Done category on tickets that had previously reached it. That replaces both heuristics with a true reopen count, and also unlocks time-to-reopen.",
    relatedGroupKeys: [],
  });
}

// ---------------------------------------------------------------------------
// 7. Defect concentration (needs groups)
// ---------------------------------------------------------------------------

function concentrationMetric(
  contexts: PeriodContext[],
  byCreatedMonth: Map<string, DefectRecord[]>,
  groups: ComputeMetricsOptions["groups"],
): DefectMetric {
  const name = `Defect concentration (top ${TOP_GROUP_COUNT} groups)`;
  const howToMeasure =
    "Needs the synthesized defect taxonomy. Computed once the analysis has produced groups: the top groups are fixed by their overall size so the monthly series stays comparable, then each month's analyzed defects are split into top-N vs the rest.";

  if (!groups || groups.length === 0) {
    return placeholder({
      key: "defect-concentration-top3",
      name,
      definition: `Not computed on this run: the defect taxonomy was not available yet. Once groups exist, this reports the percentage of each month's classified defects that fall into the ${TOP_GROUP_COUNT} largest defect groups.`,
      unit: "%",
      direction: "down-good",
      source: "jira",
      target: null,
      cadence: "monthly",
      howToMeasure,
      relatedGroupKeys: [],
    });
  }

  const ranked = [...groups].sort((a, b) => b.issueKeys.length - a.issueKeys.length);
  const top = ranked.slice(0, TOP_GROUP_COUNT);
  const topKeys = new Set(top.flatMap((g) => g.issueKeys));
  const classified = new Set(groups.flatMap((g) => g.issueKeys));
  const topNames = top.map((g) => g.name).join(", ");

  return withStats({
    key: "defect-concentration-top3",
    name,
    definition: `Of the classified customer-found defects filed in a month, the percentage landing in the ${TOP_GROUP_COUNT} largest defect groups overall (${topNames || "none"}). High concentration is good news for planning — a few fixes cover most of the pain — so the number to watch is whether it FALLS after we invest in those groups. The top groups are chosen once, from the whole population, so the monthly series is comparable across months. Defects the analysis did not classify are excluded from both numerator and denominator. ${CONVENTIONS}`,
    unit: "%",
    direction: "down-good",
    source: "jira",
    automated: true,
    target: null,
    cadence: "monthly",
    series: buildSeries(contexts, (ctx) => {
      const recs = byCreatedMonth.get(ctx.period) ?? [];
      let den = 0;
      let num = 0;
      for (const r of recs) {
        if (!classified.has(r.key)) continue;
        den++;
        if (topKeys.has(r.key)) num++;
      }
      return { value: pctOf(num, den), numerator: num, denominator: den };
    }),
    howToMeasure,
    relatedGroupKeys: top.map((g) => g.key),
  });
}

// ---------------------------------------------------------------------------
// 8. Escape-stage mix (needs signals)
// ---------------------------------------------------------------------------

function escapeStageMetrics(
  contexts: PeriodContext[],
  byKey: Map<string, DefectRecord>,
  signals: DefectSignal[] | undefined,
): DefectMetric[] {
  const howToMeasure =
    "Needs the per-ticket escape analysis. Each signal names the earliest gate that should have caught the defect; the share per gate is then bucketed by the defect's creation month. To validate it, spot-check a sample of tickets against the stage the model assigned.";

  if (!signals || signals.length === 0) {
    return [
      placeholder({
        key: "escape-stage-mix",
        name: "Escape-stage mix",
        definition:
          "Not computed on this run: per-ticket escape analysis was not available yet. Once signals exist, this becomes one metric per major detection stage, each reporting the share of that month's defects that should have been caught at that gate.",
        unit: "%",
        direction: "down-good",
        source: "jira",
        target: null,
        cadence: "monthly",
        howToMeasure,
        relatedGroupKeys: [],
      }),
    ];
  }

  // Rank the preventable stages by how many defects they account for overall,
  // so the emitted set is the handful that actually matter. "not-preventable"
  // is excluded: it is not a gate we could have closed.
  const counts = new Map<DetectionStage, number>();
  for (const s of signals) {
    if (s.detectionStage === "not-preventable") continue;
    counts.set(s.detectionStage, (counts.get(s.detectionStage) ?? 0) + 1);
  }
  const topStages = [...counts.entries()]
    .filter(([, c]) => c > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, TOP_ESCAPE_STAGE_COUNT)
    .map(([stage]) => stage);

  if (topStages.length === 0) {
    return [
      placeholder({
        key: "escape-stage-mix",
        name: "Escape-stage mix",
        definition:
          "The escape analysis classified every defect as not realistically preventable, so there is no gate-level mix to report. Re-check the extraction prompt if that looks wrong.",
        unit: "%",
        direction: "down-good",
        source: "jira",
        target: null,
        cadence: "monthly",
        howToMeasure,
        relatedGroupKeys: [],
      }),
    ];
  }

  // Signals are joined to tickets so the series is bucketed by real dates.
  const signalsByMonth = new Map<string, DefectSignal[]>();
  for (const s of signals) {
    const rec = byKey.get(s.issueKey);
    if (!rec) continue;
    const key = monthKey(rec.createdMs);
    const arr = signalsByMonth.get(key);
    if (arr) arr.push(s);
    else signalsByMonth.set(key, [s]);
  }

  return topStages.map((stage) =>
    withStats({
      key: `escape-stage-${stage}`,
      name: `Escaped ${DETECTION_STAGE_LABELS[stage].toLowerCase()}`,
      definition: `Of the analyzed defects filed in a month, the percentage whose earliest realistic catch point was "${DETECTION_STAGE_LABELS[stage]}" — i.e. defects that a working ${DETECTION_STAGE_LABELS[stage].toLowerCase()} gate should have stopped before a customer saw them. This is the escape-analysis axis: a large, flat share here says the gate is missing or ineffective, and it is the number that should move after investing in it. Defects with no signal are excluded from the denominator. ${CONVENTIONS}`,
      unit: "%",
      direction: "down-good",
      source: "jira",
      automated: true,
      target: null,
      cadence: "monthly",
      series: buildSeries(contexts, (ctx) => {
        const monthSignals = signalsByMonth.get(ctx.period) ?? [];
        const num = monthSignals.filter((s) => s.detectionStage === stage).length;
        return {
          value: pctOf(num, monthSignals.length),
          numerator: num,
          denominator: monthSignals.length,
        };
      }),
      howToMeasure,
      relatedGroupKeys: [],
    }),
  );
}

// ---------------------------------------------------------------------------
// 9. Mean preventability (needs signals)
// ---------------------------------------------------------------------------

function preventabilityMetric(
  contexts: PeriodContext[],
  byKey: Map<string, DefectRecord>,
  signals: DefectSignal[] | undefined,
): DefectMetric {
  const howToMeasure =
    "Needs the per-ticket extraction, which scores how preventable each defect was with better engineering practice (1 = essentially unavoidable, 10 = we should plainly have caught this). Averaged over each month's defects.";

  if (!signals || signals.length === 0) {
    return placeholder({
      key: "mean-preventability",
      name: "Mean preventability score",
      definition:
        "Not computed on this run: per-ticket extraction was not available yet. Once signals exist, this reports the average preventability score (1-10) of the defects filed each month.",
      unit: "score (1-10)",
      direction: "down-good",
      source: "jira",
      target: null,
      cadence: "monthly",
      howToMeasure,
      relatedGroupKeys: [],
    });
  }

  const scoresByMonth = new Map<string, number[]>();
  for (const s of signals) {
    const rec = byKey.get(s.issueKey);
    if (!rec) continue;
    if (typeof s.preventability !== "number" || Number.isNaN(s.preventability)) continue;
    const key = monthKey(rec.createdMs);
    const arr = scoresByMonth.get(key);
    if (arr) arr.push(s.preventability);
    else scoresByMonth.set(key, [s.preventability]);
  }

  return withStats({
    key: "mean-preventability",
    name: "Mean preventability score",
    definition: `Average preventability score (1-10) of the defects filed each month, where 1 means "essentially unavoidable" and 10 means "our own gates should plainly have caught this". Falling preventability is the honest sign that prevention work landed: the defects still reaching customers are the genuinely hard ones, not the ones a test would have caught. Scored per ticket by the analysis, so it moves with the model's judgement as well as with reality — compare across months of the same run, not across prompt revisions. ${CONVENTIONS}`,
    unit: "score (1-10)",
    direction: "down-good",
    source: "jira",
    automated: true,
    target: null,
    cadence: "monthly",
    series: buildSeries(contexts, (ctx) => {
      const scores = scoresByMonth.get(ctx.period) ?? [];
      const m = mean(scores);
      return { value: m === null ? null : round1(m), denominator: scores.length };
    }),
    howToMeasure,
    relatedGroupKeys: [],
  });
}

// ---------------------------------------------------------------------------
// 10. Regression rate (needs signals)
// ---------------------------------------------------------------------------

function regressionMetric(
  contexts: PeriodContext[],
  byKey: Map<string, DefectRecord>,
  signals: DefectSignal[] | undefined,
): DefectMetric {
  const howToMeasure =
    "Needs the per-ticket extraction's `isRegression` flag. A stronger version links each defect to the release that introduced it, which requires changelog or release-tag data this tool does not yet ingest.";

  if (!signals || signals.length === 0) {
    return placeholder({
      key: "regression-rate",
      name: "Regression rate",
      definition:
        "Not computed on this run: per-ticket extraction was not available yet. Once signals exist, this reports the share of each month's defects that broke something that used to work.",
      unit: "%",
      direction: "down-good",
      source: "jira",
      target: null,
      cadence: "monthly",
      howToMeasure,
      relatedGroupKeys: [],
    });
  }

  const byMonth = new Map<string, DefectSignal[]>();
  for (const s of signals) {
    const rec = byKey.get(s.issueKey);
    if (!rec) continue;
    const key = monthKey(rec.createdMs);
    const arr = byMonth.get(key);
    if (arr) arr.push(s);
    else byMonth.set(key, [s]);
  }

  return withStats({
    key: "regression-rate",
    name: "Regression rate",
    definition: `Of the analyzed defects filed in a month, the percentage the analysis flagged as regressions — something that used to work and stopped. Regressions are the most damaging class of customer-found defect because they punish customers for upgrading, and they are the class most directly addressable with tests. Defects with no signal are excluded from the denominator. ${CONVENTIONS}`,
    unit: "%",
    direction: "down-good",
    source: "jira",
    automated: true,
    target: null,
    cadence: "monthly",
    series: buildSeries(contexts, (ctx) => {
      const monthSignals = byMonth.get(ctx.period) ?? [];
      const num = monthSignals.filter((s) => s.isRegression).length;
      return {
        value: pctOf(num, monthSignals.length),
        numerator: num,
        denominator: monthSignals.length,
      };
    }),
    howToMeasure,
    relatedGroupKeys: [],
  });
}

// ---------------------------------------------------------------------------
// 11. Fix-with-test rate (needs correlation)
// ---------------------------------------------------------------------------

function fixWithTestMetric(
  contexts: PeriodContext[],
  correlation: CodeCorrelation | null,
): DefectMetric {
  const howToMeasure =
    "Needs the git correlation: fix commits are found by searching the product repo's history for the ticket key, and a commit counts as tested when at least one changed path looks like a test. If the repo path is unset or unreadable this stays dark — point `codeRepoPath` at the product repo to light it up. Enforcing it in CI (block a bug-fix PR with no test change) is the intervention this metric measures.";

  if (!correlation) {
    return placeholder({
      key: "fix-with-test-rate",
      name: "Fix-with-test rate",
      definition:
        "Not computed on this run: no code correlation was available. Once the product repo is correlated, this reports the share of defect-fixing commits that also changed a test file — the single most actionable code-quality number in this report, because a fix without a test is a fix that can silently regress.",
      unit: "%",
      direction: "up-good",
      source: "code",
      target: null,
      cadence: "monthly",
      howToMeasure,
      relatedGroupKeys: [],
    });
  }

  // Dedupe by sha: one commit can reference several tickets.
  const commits = new Map<string, { ms: number | null; touchesTests: boolean }>();
  for (const link of correlation.links ?? []) {
    for (const c of link.commits ?? []) {
      if (!commits.has(c.sha)) {
        commits.set(c.sha, { ms: parseMs(c.date), touchesTests: c.touchesTests });
      }
    }
  }
  const byMonth = bucketByMonth([...commits.values()], (c) => c.ms);

  return withStats({
    key: "fix-with-test-rate",
    name: "Fix-with-test rate",
    definition: `Of the commits that fixed a customer-found defect in a month, the percentage that also changed a test file. Bucketed by COMMIT date, and de-duplicated by sha so a commit fixing three tickets counts once. This is the most actionable code-quality metric in the report: a bug fix shipped without a test is a bug that can come back silently, and unlike most metrics here this one is directly enforceable in code review or CI. ${CONVENTIONS}`,
    unit: "%",
    direction: "up-good",
    source: "code",
    automated: true,
    target: null,
    cadence: "monthly",
    series: buildSeries(contexts, (ctx) => {
      const monthCommits = byMonth.get(ctx.period) ?? [];
      const num = monthCommits.filter((c) => c.touchesTests).length;
      return {
        value: pctOf(num, monthCommits.length),
        numerator: num,
        denominator: monthCommits.length,
      };
    }),
    howToMeasure,
    relatedGroupKeys: [],
  });
}

// ---------------------------------------------------------------------------
// 12. Code hotspot concentration (needs correlation)
// ---------------------------------------------------------------------------

function hotspotConcentrationMetric(
  contexts: PeriodContext[],
  byKey: Map<string, DefectRecord>,
  correlation: CodeCorrelation | null,
): DefectMetric {
  const name = `Hotspot concentration (top ${TOP_HOTSPOT_COUNT} paths)`;
  const howToMeasure =
    "Needs the git correlation. The hottest paths are ranked once over the whole population so the monthly series is comparable; each month then splits its code-linked defects into hotspot vs elsewhere. Defects with no fix commit found are excluded.";

  const hotspots = correlation
    ? correlation.fileHotspots?.length
      ? correlation.fileHotspots
      : (correlation.areaHotspots ?? [])
    : [];

  if (!correlation || hotspots.length === 0) {
    return placeholder({
      key: "hotspot-concentration-top10",
      name,
      definition: correlation
        ? "Not computed on this run: the code correlation found no hotspots (no defect fixes were linked to repo files). Check that the repo path is right and that fix commits reference the ticket key."
        : `Not computed on this run: no code correlation was available. Once the product repo is correlated, this reports the share of code-linked defects whose fixes landed in the ${TOP_HOTSPOT_COUNT} hottest paths.`,
      unit: "%",
      direction: "down-good",
      source: "code",
      target: null,
      cadence: "monthly",
      howToMeasure,
      relatedGroupKeys: [],
    });
  }

  const topKeys = new Set(hotspots.slice(0, TOP_HOTSPOT_COUNT).flatMap((h) => h.issueKeys ?? []));
  const linkedKeys = new Set(
    (correlation.links ?? []).filter((l) => (l.commits ?? []).length > 0).map((l) => l.issueKey),
  );

  const linkedByMonth = new Map<string, string[]>();
  for (const key of linkedKeys) {
    const rec = byKey.get(key);
    if (!rec) continue;
    const period = monthKey(rec.createdMs);
    const arr = linkedByMonth.get(period);
    if (arr) arr.push(key);
    else linkedByMonth.set(period, [key]);
  }

  return withStats({
    key: "hotspot-concentration-top10",
    name,
    definition: `Of the defects filed in a month whose fix we could locate in the repo, the percentage whose fix touched one of the ${TOP_HOTSPOT_COUNT} hottest paths in the codebase. High concentration means the pain has an address: a small number of files are generating most customer defects, and hardening them is a bounded piece of work. The number to watch is whether it falls after that work lands. The hottest paths are fixed from the whole population so months stay comparable. ${CONVENTIONS}`,
    unit: "%",
    direction: "down-good",
    source: "code",
    automated: true,
    target: null,
    cadence: "monthly",
    series: buildSeries(contexts, (ctx) => {
      const keys = linkedByMonth.get(ctx.period) ?? [];
      const num = keys.filter((k) => topKeys.has(k)).length;
      return { value: pctOf(num, keys.length), numerator: num, denominator: keys.length };
    }),
    howToMeasure,
    relatedGroupKeys: [],
  });
}

// ---------------------------------------------------------------------------
// Proposed (not yet instrumentable here)
// ---------------------------------------------------------------------------

/**
 * The short list of metrics this tool genuinely cannot compute from JIRA plus
 * git, but that engineering should instrument. Deliberately small: five numbers
 * a VP can chase, not a wishlist.
 */
function proposedMetrics(): DefectMetric[] {
  const base = {
    automated: false as const,
    current: null,
    baseline: null,
    target: null,
    series: [] as MetricPoint[],
    cadence: "monthly" as const,
    relatedGroupKeys: [] as string[],
  };
  return [
    {
      ...base,
      key: "defect-escape-rate",
      name: "Defect escape rate",
      definition:
        "Of all defects found in a release, the share found by CUSTOMERS rather than by us. This dashboard sees only the customer-found half, so it can count the numerator but not the denominator — and without the denominator, falling customer-found inflow is ambiguous (did we get better, or did we just ship less?). This is the single most valuable metric to add.",
      unit: "%",
      direction: "down-good",
      source: "jira" as const,
      howToMeasure:
        "Add a JQL population for internally-found bugs in the same project and window (bugs with an empty Customer field, or reported by an internal account / found-by field), then compute `customer-found / (customer-found + internally-found)` per month. Cheapest high-value instrumentation on this list: it needs one more saved query, not new tooling.",
    },
    {
      ...base,
      key: "mean-time-to-detect",
      name: "Mean time to detect",
      definition:
        "Calendar days from the commit that introduced a defect to the moment anyone noticed it. Time-to-resolve only measures our reaction; time-to-detect measures how long customers ran on broken code before we knew. A long MTTD points at observability gaps, not at test gaps.",
      unit: "days",
      direction: "down-good",
      source: "runtime" as const,
      howToMeasure:
        "Requires linking each defect to the introducing commit (`git bisect`, or `git blame` on the lines the fix changed) and to the release that carried it. Approximate today with `defect reported at − release ship date` for defects flagged as regressions, which needs release tags in the repo and a ship-date table.",
    },
    {
      ...base,
      key: "hotspot-test-coverage",
      name: "Test coverage on hotspot paths",
      definition:
        "Line/branch coverage restricted to the hottest defect paths identified by the code correlation. Repo-wide coverage is a vanity number; coverage on the ten files that actually break is a decision-support number.",
      unit: "%",
      direction: "up-good",
      source: "ci" as const,
      howToMeasure:
        "Publish the coverage report from CI as a machine-readable artifact (lcov/cobertura), then intersect it with the `fileHotspots` paths this report already produces. Gate the hotspot subset in CI at a higher threshold than the repo default.",
    },
    {
      ...base,
      key: "ci-flake-rate",
      name: "CI flake rate",
      definition:
        "Share of CI runs that failed non-deterministically (failed, then passed unchanged on retry). Flaky suites are the mechanism by which good tests stop preventing defects: once red is normal, engineers stop reading it, and real failures ship.",
      unit: "%",
      direction: "down-good",
      source: "ci" as const,
      howToMeasure:
        "Record every CI run's outcome keyed by commit sha; a sha that produced both a fail and a pass with no new commit is a flake. Report flakes/total runs weekly, and track the top flaky test files alongside the defect hotspots.",
    },
    {
      ...base,
      key: "scale-test-tenant-coverage",
      name: "Scale-test coverage of top tenants",
      definition:
        "Share of our largest tenants whose real data shape and volume are represented in an automated scale test. Data-volume and data-shape defects are heavily over-represented in customer-found bugs precisely because our test fixtures are small and tidy.",
      unit: "%",
      direction: "up-good",
      source: "ci" as const,
      cadence: "quarterly" as const,
      howToMeasure:
        "Take the top N tenants by entity count, record each one's shape profile (entity counts per type, identity-graph depth, connector mix), and mark a tenant covered when a scheduled scale test runs against a synthetic dataset within an order of magnitude of that profile. Review quarterly — it moves slowly and is a planning input, not a dashboard twitch.",
    },
  ];
}
