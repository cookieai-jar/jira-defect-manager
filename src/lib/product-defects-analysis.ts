import type { JiraIssue } from "@/types/triage";
import type {
  ActionPriority,
  CodeCorrelation,
  CodeHotspot,
  ComponentAnalysis,
  DefectGroup,
  DefectMetric,
  DefectSignal,
  DefectSubGroup,
  DefectTrigger,
  DetectionStage,
  Effort,
  MetricDirection,
  MetricSource,
  PreventionDiscipline,
  PreventionStrategy,
  ProductDefectAnalysis,
  RootCause,
  TeamActionPlan,
} from "@/types/product-defects";
import {
  ACTION_PRIORITIES,
  DEFECT_TRIGGERS,
  DETECTION_STAGES,
  EFFORTS,
  METRIC_SOURCES,
  PREVENTION_DISCIPLINES,
} from "@/types/product-defects";
import { defaultModel, jsonCompletion } from "./anthropic";
import { daysSince } from "./utils";

/**
 * The completion function the analyzer depends on. Defaults to the real
 * Anthropic-backed `jsonCompletion`, but is injectable so the whole five-phase
 * orchestration can be unit-tested without a single network call.
 */
export type CompletionFn = <T>(opts: {
  model: string;
  system: string;
  user: string;
  systemCacheable?: boolean;
  maxTokens?: number;
}) => Promise<T>;

// ---------------------------------------------------------------------------
// Pure helpers (exported for testing)
// ---------------------------------------------------------------------------

export function clamp(n: number, lo: number, hi: number): number {
  if (Number.isNaN(n)) return lo;
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

/** Lowercase, hyphenated slug; collapses runs of non-alphanumerics. */
export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "uncategorized"
  );
}

export function batchIssues(issues: JiraIssue[], size: number): JiraIssue[][] {
  const n = Math.max(1, Math.floor(size));
  const out: JiraIssue[][] = [];
  for (let i = 0; i < issues.length; i += n) out.push(issues.slice(i, i + n));
  return out;
}

/** Normalize a free-text label for grouping/matching (case- and space-insensitive). */
export function normLabel(name: string): string {
  return name.toLowerCase().replace(/\s+/g, " ").trim();
}

function cleanStr(v: unknown, max = 600): string {
  if (typeof v !== "string") return "";
  return v.trim().slice(0, max);
}

function num(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** Number or null — used for metric targets, where "no target" is meaningful. */
function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function toBool(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return ["true", "yes", "y", "1"].includes(v.trim().toLowerCase());
  if (typeof v === "number") return v !== 0;
  return false;
}

function toStringArray(v: unknown, maxLen = 240): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => (typeof x === "string" ? x.trim() : ""))
    .filter((x) => x.length > 0)
    .map((x) => x.slice(0, maxLen));
}

function uniq(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

/**
 * Constrain a model-supplied string to a known union. Anything off-list falls
 * back rather than corrupting the data — a bogus `detectionStage` that leaked
 * through would silently skew the entire escape analysis.
 */
export function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  return (allowed as readonly string[]).includes(s) ? (s as T) : fallback;
}

/** Round to one decimal — averages are displayed, not used for further math. */
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Percentage of `total`, rounded to a whole number and bounded to 0-100. */
export function pct(part: number, total: number): number {
  if (!Number.isFinite(total) || total <= 0) return 0;
  return clamp((part / total) * 100, 0, 100);
}

/** Top-N values by frequency, most frequent first. */
function topByFrequency(values: string[], n: number): string[] {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n)
    .map(([v]) => v);
}

/**
 * Count a union-typed field across signals, descending by count with the
 * canonical union order as a stable tie-break (so runs are reproducible).
 */
function countBy<T extends string>(
  values: T[],
  order: readonly T[],
): Array<{ value: T; count: number }> {
  const counts = new Map<T, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || order.indexOf(a.value) - order.indexOf(b.value));
}

const PRIORITY_RANK: Record<ActionPriority, number> = { now: 0, next: 1, later: 2 };
const DISCIPLINE_RANK: Record<PreventionDiscipline, number> = PREVENTION_DISCIPLINES.reduce(
  (acc, d, i) => {
    acc[d] = i;
    return acc;
  },
  {} as Record<PreventionDiscipline, number>,
);

/** Make `key` unique within `used`, appending -2, -3, … as needed. */
function uniqueKey(key: string, used: Set<string>): string {
  if (!used.has(key)) {
    used.add(key);
    return key;
  }
  for (let i = 2; ; i++) {
    const candidate = `${key}-${i}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
}

/**
 * Human label for a CODEOWNERS team slug: "@cookieai-jar/lifecycle-mgmt" →
 * "Lifecycle Mgmt". Falls back to the raw string when it isn't slug-shaped.
 */
export function teamLabel(team: string): string {
  const tail = team.replace(/^@/, "").split("/").pop() ?? team;
  const words = tail.split(/[-_.\s]+/).filter(Boolean);
  if (words.length === 0) return team;
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

/** Compact JSON representation of a ticket for the extraction prompt. */
export function compactIssue(issue: JiraIssue): string {
  const lastComments = issue.comments.slice(-4).map((c) => ({
    author: c.author,
    when: c.created.slice(0, 10),
    body: c.body.slice(0, 900),
  }));
  return JSON.stringify({
    key: issue.key,
    summary: issue.summary,
    status: issue.status,
    priority: issue.priority,
    issueType: issue.issueType,
    components: issue.components,
    labels: issue.labels,
    customers: issue.customers,
    created: issue.created,
    resolved: issue.resolved,
    daysToResolve:
      issue.resolved && issue.created
        ? Math.max(
            0,
            Math.round(
              (new Date(issue.resolved).getTime() - new Date(issue.created).getTime()) / 86_400_000,
            ),
          )
        : null,
    daysSinceUpdate: daysSince(issue.updated),
    description: issue.description?.slice(0, 1600) ?? null,
    commentCount: issue.comments.length,
    lastComments,
  });
}

// ---------------------------------------------------------------------------
// Phase 1 — per-ticket extraction
// ---------------------------------------------------------------------------

interface RawSignal {
  issueKey?: unknown;
  area?: unknown;
  failureMode?: unknown;
  symptom?: unknown;
  suspectedRootCause?: unknown;
  triggerCondition?: unknown;
  trigger?: unknown;
  escapeReason?: unknown;
  detectionStage?: unknown;
  errorSignatures?: unknown;
  category?: unknown;
  subCategory?: unknown;
  isRegression?: unknown;
  customerImpact?: unknown;
  severityScore?: unknown;
  preventability?: unknown;
}

/**
 * Normalize the model's per-ticket extraction output into exactly one signal
 * per ticket in the batch.
 *
 * Two invariants matter here. First, the batch — not the model — decides which
 * tickets exist: entries whose `issueKey` is not in this batch are dropped
 * (the model does occasionally hallucinate neighbouring keys, and a phantom
 * ticket would inflate every downstream count). Second, tickets the model
 * skipped still get a signal, derived from the ticket itself, so a partial or
 * failed response never loses a defect from the population.
 */
export function normalizeSignals(raw: unknown, batch: JiraIssue[]): DefectSignal[] {
  const arr: RawSignal[] = Array.isArray(raw) ? (raw as RawSignal[]) : [];
  const inBatch = new Set(batch.map((i) => i.key));
  const byKey = new Map<string, RawSignal>();
  for (const r of arr) {
    const k = typeof r?.issueKey === "string" ? r.issueKey.trim() : "";
    if (k && inBatch.has(k) && !byKey.has(k)) byKey.set(k, r);
  }
  return batch.map((issue) => {
    const r = byKey.get(issue.key);
    const area = cleanStr(r?.area, 100) || issue.components[0] || "";
    const trigger = oneOf<DefectTrigger>(r?.trigger, DEFECT_TRIGGERS, "unknown");
    const isRegression = toBool(r?.isRegression) || trigger === "regression";
    return {
      issueKey: issue.key,
      area: area || null,
      failureMode: cleanStr(r?.failureMode, 160) || "Unclassified",
      symptom: cleanStr(r?.symptom, 400) || issue.summary,
      suspectedRootCause: cleanStr(r?.suspectedRootCause, 500) || "Undetermined",
      triggerCondition: cleanStr(r?.triggerCondition, 400) || "Undetermined",
      trigger,
      escapeReason: cleanStr(r?.escapeReason, 500) || "Undetermined",
      // "unclassified" — never "not-preventable" — is the fallback for a
      // missing or off-list stage. "not-preventable" is a judgement the model
      // has to make deliberately; defaulting to it would let a failed batch
      // inflate the "nothing could have caught it" bucket and understate the
      // very escape gap this report exists to find.
      detectionStage: oneOf<DetectionStage>(r?.detectionStage, DETECTION_STAGES, "unclassified"),
      errorSignatures: uniq(toStringArray(r?.errorSignatures, 200)).slice(0, 8),
      category: cleanStr(r?.category, 120) || "Uncategorized",
      subCategory: cleanStr(r?.subCategory, 120) || "",
      isRegression,
      customerImpact: cleanStr(r?.customerImpact, 400) || issue.summary,
      severityScore: clamp(num(r?.severityScore, 5), 1, 10),
      preventability: clamp(num(r?.preventability, 5), 1, 10),
    };
  });
}

// ---------------------------------------------------------------------------
// Phase 2 — synthesis into the two-level taxonomy
// ---------------------------------------------------------------------------

export interface CategoryRollup {
  category: string;
  count: number;
  /** Raw sub-category labels within this category, with counts. */
  subCategories: Array<{ name: string; count: number }>;
  topAreas: string[];
  topFailureModes: string[];
  detectionStages: Array<{ stage: DetectionStage; count: number }>;
  triggers: Array<{ trigger: DefectTrigger; count: number }>;
  severityAvg: number;
  preventabilityAvg: number;
  regressionCount: number;
  samples: Array<{
    key: string;
    area: string | null;
    failureMode: string;
    symptom: string;
    suspectedRootCause: string;
    escapeReason: string;
    detectionStage: DetectionStage;
    trigger: DefectTrigger;
  }>;
}

/**
 * Group signals by their extracted category label. This is the deterministic
 * backbone of synthesis: the model sees compact rollups (one object per
 * category) instead of 1300 tickets, so the prompt — and the model's output —
 * scale with the number of categories, not with ticket volume.
 */
export function rollupByCategory(signals: DefectSignal[], samplesPerCategory = 6): CategoryRollup[] {
  const groups = new Map<string, DefectSignal[]>();
  const display = new Map<string, string>();
  for (const s of signals) {
    const k = normLabel(s.category) || "uncategorized";
    if (!groups.has(k)) {
      groups.set(k, []);
      display.set(k, s.category.trim() || "Uncategorized");
    }
    groups.get(k)!.push(s);
  }
  return [...groups.entries()]
    .map(([k, sigs]) => {
      const subCounts = new Map<string, number>();
      const subDisplay = new Map<string, string>();
      for (const s of sigs) {
        const label = s.subCategory.trim();
        if (!label) continue;
        const n = normLabel(label);
        subCounts.set(n, (subCounts.get(n) ?? 0) + 1);
        if (!subDisplay.has(n)) subDisplay.set(n, label);
      }
      const sorted = [...sigs].sort(
        (a, b) => b.severityScore - a.severityScore || a.issueKey.localeCompare(b.issueKey),
      );
      return {
        category: display.get(k) ?? k,
        count: sigs.length,
        subCategories: [...subCounts.entries()]
          .map(([n, count]) => ({ name: subDisplay.get(n) ?? n, count }))
          .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
          .slice(0, 12),
        topAreas: topByFrequency(
          sigs.map((s) => s.area).filter((x): x is string => Boolean(x)),
          6,
        ),
        topFailureModes: topByFrequency(
          sigs.map((s) => s.failureMode).filter(Boolean),
          6,
        ),
        detectionStages: countBy(
          sigs.map((s) => s.detectionStage),
          DETECTION_STAGES,
        ).map(({ value, count }) => ({ stage: value, count })),
        triggers: countBy(
          sigs.map((s) => s.trigger),
          DEFECT_TRIGGERS,
        ).map(({ value, count }) => ({ trigger: value, count })),
        severityAvg: round1(sigs.reduce((n, s) => n + s.severityScore, 0) / sigs.length),
        preventabilityAvg: round1(sigs.reduce((n, s) => n + s.preventability, 0) / sigs.length),
        regressionCount: sigs.filter((s) => s.isRegression).length,
        samples: sorted.slice(0, samplesPerCategory).map((s) => ({
          key: s.issueKey,
          area: s.area,
          failureMode: s.failureMode,
          symptom: s.symptom,
          suspectedRootCause: s.suspectedRootCause,
          escapeReason: s.escapeReason,
          detectionStage: s.detectionStage,
          trigger: s.trigger,
        })),
      };
    })
    .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category));
}

interface RawSubGroup {
  name?: unknown;
  description?: unknown;
  mergesSubCategories?: unknown;
}
interface RawGroup {
  name?: unknown;
  description?: unknown;
  mergesCategories?: unknown;
  subGroups?: unknown;
}
interface RawSynthesis {
  executiveSummary?: unknown;
  groups?: unknown;
}

export interface SynthesisResult {
  executiveSummary: string;
  groups: DefectGroup[];
}

/**
 * Hard ceiling on top-level groups, INCLUDING the remainder bucket. The
 * synthesis prompt asks for 6-12; a real 1294-ticket run returned groups that
 * left half the raw labels unplaced, which — before this cap — produced 28
 * groups, most of them singletons. A leadership report cannot have 28 sections,
 * so anything past the ceiling is folded into the remainder bucket by volume.
 */
export const MAX_TOP_LEVEL_GROUPS = 14;

/** Name of the single catch-all group for labels the taxonomy never placed. */
export const REMAINDER_GROUP_NAME = "Other / unclassified patterns";

/** One canonical group, resolved to the raw category labels it owns. */
interface GroupSpec {
  name: string;
  description: string;
  /** Normalized raw category labels this group claims. */
  norms: string[];
  subs: RawSubGroup[];
}

/**
 * Resolve the model's groups to raw category labels, first-claim-wins.
 * Shared by `normalizeSynthesis` and `unplacedCategoryLabels` so the two can
 * never disagree about which labels the first pass left on the floor.
 */
function planGroups(
  raw: unknown,
  byRawCat: Map<string, DefectSignal[]>,
): { specs: GroupSpec[]; consumed: Set<string> } {
  const r = (raw && typeof raw === "object" ? raw : {}) as RawSynthesis;
  const rawGroups: RawGroup[] = Array.isArray(r.groups) ? (r.groups as RawGroup[]) : [];
  const consumed = new Set<string>();
  const specs: GroupSpec[] = [];
  for (const g of rawGroups) {
    const name = cleanStr(g?.name, 120) || "Uncategorized";
    const claimed = uniq([
      normLabel(name),
      ...toStringArray(g?.mergesCategories, 120).map(normLabel),
    ]).filter((m) => byRawCat.has(m) && !consumed.has(m));
    for (const m of claimed) consumed.add(m);
    specs.push({
      name,
      description: cleanStr(g?.description, 900),
      norms: claimed,
      subs: Array.isArray(g?.subGroups) ? (g.subGroups as RawSubGroup[]) : [],
    });
  }
  return { specs, consumed };
}

/** A raw category label the first synthesis pass failed to place. */
export interface UnplacedLabel {
  label: string;
  count: number;
  topFailureModes: string[];
  topAreas: string[];
  sampleSymptoms: string[];
}

/**
 * The raw category labels the model's taxonomy did not claim, largest first.
 * Feeds the cheap second-pass placement call — we only re-ask about the tail,
 * not the whole taxonomy.
 */
export function unplacedCategoryLabels(raw: unknown, signals: DefectSignal[]): UnplacedLabel[] {
  const { byRawCat, rawDisplay } = groupSignalsByRawCategory(signals);
  const { consumed } = planGroups(raw, byRawCat);
  return [...byRawCat.entries()]
    .filter(([norm]) => !consumed.has(norm))
    .map(([norm, sigs]) => ({
      label: rawDisplay.get(norm) ?? norm,
      count: sigs.length,
      topFailureModes: topByFrequency(sigs.map((s) => s.failureMode).filter(Boolean), 4),
      topAreas: topByFrequency(
        sigs.map((s) => s.area).filter((x): x is string => Boolean(x)),
        4,
      ),
      sampleSymptoms: uniq(sigs.map((s) => s.symptom).filter(Boolean)).slice(0, 2),
    }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

/** Second-pass assignment of one leftover label to a canonical group. */
export interface LabelAssignment {
  label: string;
  /** Canonical group name, or "none" when the model declined to place it. */
  group: string;
}

export function normalizeAssignments(raw: unknown): LabelAssignment[] {
  const container = raw && typeof raw === "object" ? (raw as { assignments?: unknown }) : {};
  const arr = Array.isArray(raw) ? raw : Array.isArray(container.assignments) ? container.assignments : [];
  const out: LabelAssignment[] = [];
  for (const a of arr as Array<{ label?: unknown; group?: unknown }>) {
    const label = cleanStr(a?.label, 120);
    const group = cleanStr(a?.group, 120);
    if (label && group) out.push({ label, group });
  }
  return out;
}

export interface SynthesisNormalizeOptions {
  /** Second-pass label → canonical group assignments, merged before bucketing. */
  assignments?: LabelAssignment[];
  /** Ceiling on top-level groups, including the remainder bucket. */
  maxGroups?: number;
}

function groupSignalsByRawCategory(signals: DefectSignal[]) {
  const byRawCat = new Map<string, DefectSignal[]>();
  const rawDisplay = new Map<string, string>();
  for (const s of signals) {
    const k = normLabel(s.category) || "uncategorized";
    if (!byRawCat.has(k)) {
      byRawCat.set(k, []);
      rawDisplay.set(k, s.category.trim() || "Uncategorized");
    }
    byRawCat.get(k)!.push(s);
  }
  return { byRawCat, rawDisplay };
}

/** Aggregate the deterministic stats a group/sub-group carries. */
function statsFor(sigs: DefectSignal[]) {
  return {
    topAreas: topByFrequency(
      sigs.map((s) => s.area).filter((x): x is string => Boolean(x)),
      6,
    ),
    detectionStages: countBy(
      sigs.map((s) => s.detectionStage),
      DETECTION_STAGES,
    ).map(({ value, count }) => ({ stage: value, count })),
    triggers: countBy(
      sigs.map((s) => s.trigger),
      DEFECT_TRIGGERS,
    ).map(({ value, count }) => ({ trigger: value, count })),
    severityAvg:
      sigs.length > 0 ? round1(sigs.reduce((n, s) => n + s.severityScore, 0) / sigs.length) : 0,
    preventabilityAvg:
      sigs.length > 0 ? round1(sigs.reduce((n, s) => n + s.preventability, 0) / sigs.length) : 0,
    regressionCount: sigs.filter((s) => s.isRegression).length,
    exampleQuotes: uniq(sigs.map((s) => s.symptom).filter(Boolean)).slice(0, 3),
  };
}

/**
 * Build the canonical two-level taxonomy.
 *
 * The model only decides *naming and merging* — which raw category labels roll
 * up into which canonical group, and which raw sub-category labels roll up into
 * which sub-group. Membership, counts, shares and every average are recomputed
 * here from the signals, so a model that miscounts (they all do) cannot corrupt
 * the numbers the dashboard reports.
 *
 * Invariants enforced:
 *  - every signal lands in exactly one group;
 *  - a signal lands in at most one sub-group of its group;
 *  - shares are recomputed: group share over all analyzed tickets, sub-group
 *    share over its parent group's tickets;
 *  - at most `maxGroups` top-level groups, with everything the taxonomy failed
 *    to place collected in ONE remainder bucket rather than N singletons.
 */
export function normalizeSynthesis(
  raw: unknown,
  signals: DefectSignal[],
  opts: SynthesisNormalizeOptions = {},
): SynthesisResult {
  const r = (raw && typeof raw === "object" ? raw : {}) as RawSynthesis;
  const analyzed = signals.length;
  const maxGroups = Math.max(1, opts.maxGroups ?? MAX_TOP_LEVEL_GROUPS);

  // Local grouping by raw category label — the ground truth for membership.
  const { byRawCat, rawDisplay } = groupSignalsByRawCategory(signals);
  const usedGroupKeys = new Set<string>();

  // `memberNorms` are already exclusive — `planGroups` resolved the
  // first-claim-wins contest before anything is materialized.
  function buildGroup(spec: GroupSpec): DefectGroup {
    const { name, norms: memberNorms, description, subs: rawSubs } = spec;
    const sigByKey = new Map<string, DefectSignal>();
    for (const m of memberNorms) {
      for (const s of byRawCat.get(m) ?? []) sigByKey.set(s.issueKey, s);
    }
    const sigList = [...sigByKey.values()];
    const stats = statsFor(sigList);

    // Sub-groups: same claim-once discipline, but scoped to this group's
    // signals and keyed on the raw sub-category label.
    const bySubCat = new Map<string, DefectSignal[]>();
    for (const s of sigList) {
      const label = normLabel(s.subCategory);
      if (!label) continue;
      if (!bySubCat.has(label)) bySubCat.set(label, []);
      bySubCat.get(label)!.push(s);
    }
    const claimedSubs = new Set<string>();
    const usedSubKeys = new Set<string>();
    const subGroups: DefectSubGroup[] = [];
    for (const rs of rawSubs) {
      const subName = cleanStr(rs?.name, 120);
      if (!subName) continue;
      const merges = uniq([
        normLabel(subName),
        ...toStringArray(rs?.mergesSubCategories, 120).map(normLabel),
      ]).filter((m) => bySubCat.has(m) && !claimedSubs.has(m));
      const subSigs: DefectSignal[] = [];
      for (const m of merges) {
        claimedSubs.add(m);
        subSigs.push(...(bySubCat.get(m) ?? []));
      }
      if (subSigs.length === 0) continue; // empty sub-group is noise, drop it
      const subStats = statsFor(subSigs);
      subGroups.push({
        key: uniqueKey(slugify(subName), usedSubKeys),
        name: subName,
        description: cleanStr(rs?.description, 600),
        issueKeys: subSigs.map((s) => s.issueKey),
        ticketCount: subSigs.length,
        share: pct(subSigs.length, sigList.length),
        topAreas: subStats.topAreas,
        rootCauses: [],
        exampleQuotes: subStats.exampleQuotes,
        // Sub-groups are where the gates actually diverge, so carry the same
        // escape-analysis aggregates down a level rather than discarding them.
        detectionStages: subStats.detectionStages,
        triggers: subStats.triggers,
        severityAvg: subStats.severityAvg,
        preventabilityAvg: subStats.preventabilityAvg,
        regressionCount: subStats.regressionCount,
      });
    }
    subGroups.sort((a, b) => b.ticketCount - a.ticketCount || a.name.localeCompare(b.name));

    return {
      key: uniqueKey(slugify(name), usedGroupKeys),
      name,
      description,
      issueKeys: sigList.map((s) => s.issueKey),
      ticketCount: sigList.length,
      share: pct(sigList.length, analyzed),
      subGroups,
      rootCauses: [],
      analysis: "",
      escapeAnalysis: "",
      topAreas: stats.topAreas,
      detectionStages: stats.detectionStages,
      triggers: stats.triggers,
      severityAvg: stats.severityAvg,
      preventabilityAvg: stats.preventabilityAvg,
      regressionCount: stats.regressionCount,
      exampleQuotes: stats.exampleQuotes,
    };
  }

  const { specs, consumed } = planGroups(raw, byRawCat);

  // Layer 2: fold in the second-pass placements for labels the first pass
  // missed. Matched on group name (or its slug), and still claim-once.
  const specByName = new Map<string, GroupSpec>();
  for (const s of specs) {
    for (const alias of [normLabel(s.name), slugify(s.name)]) {
      if (!specByName.has(alias)) specByName.set(alias, s);
    }
  }
  for (const a of opts.assignments ?? []) {
    const norm = normLabel(a.label);
    if (!byRawCat.has(norm) || consumed.has(norm)) continue;
    const target = specByName.get(normLabel(a.group)) ?? specByName.get(slugify(a.group));
    if (!target) continue; // "none" or an unknown group → stays for the remainder
    target.norms.push(norm);
    consumed.add(norm);
  }

  // Materialize the named groups, largest first. Keep each group paired with
  // its spec so the ceiling can recover the labels of anything it folds.
  const named = specs
    .map((spec) => ({ spec, group: buildGroup(spec) }))
    .filter((x) => x.group.ticketCount > 0)
    .sort(
      (a, b) => b.group.ticketCount - a.group.ticketCount || a.group.name.localeCompare(b.group.name),
    );

  // Layer 3: everything still unplaced goes into ONE bucket — not N singletons.
  const remainderNorms = [...byRawCat.keys()].filter((n) => !consumed.has(n));

  // Ceiling: keep the largest named groups and fold the tail into the bucket.
  // Reserve a slot for the remainder whenever it will be non-empty.
  let keep = named;
  const foldedNorms: string[] = [];
  const needsRemainderSlot = remainderNorms.length > 0;
  if (named.length + (needsRemainderSlot ? 1 : 0) > maxGroups) {
    const keepCount = Math.max(1, maxGroups - 1);
    keep = named.slice(0, keepCount);
    for (const { spec } of named.slice(keepCount)) foldedNorms.push(...spec.norms);
  }

  const bucketNorms = uniq([...remainderNorms, ...foldedNorms]);
  const groups = keep.map((x) => x.group);
  if (bucketNorms.length > 0) {
    const bucket = buildGroup({
      name: REMAINDER_GROUP_NAME,
      // State plainly what this is. A fat remainder means synthesis did a poor
      // job, and the reader should be able to see that rather than mistake the
      // bucket for a real pattern.
      description: `${bucketNorms.length} extraction ${
        bucketNorms.length === 1 ? "category" : "categories"
      } the synthesis did not merge into a named group${
        foldedNorms.length > 0 ? ` (including ${foldedNorms.length} folded in at the ${maxGroups}-group ceiling)` : ""
      }: ${bucketNorms
        .map((n) => rawDisplay.get(n) ?? n)
        .slice(0, 12)
        .join(", ")}. These are mostly low-volume patterns; a large bucket means the taxonomy needs another pass, not that these defects share a cause.`,
      norms: bucketNorms,
      subs: [],
    });
    // Pinned last: it is a catch-all, and leadership should read the named
    // groups first even when the bucket is large.
    if (bucket.ticketCount > 0) groups.push(bucket);
  }

  return {
    executiveSummary: cleanStr(r.executiveSummary, 1400),
    groups,
  };
}

// ---------------------------------------------------------------------------
// Phase 3 — per-group deep dive
// ---------------------------------------------------------------------------

/** One hotspot as handed to a prompt. */
export interface PromptHotspot {
  path: string;
  defectCount: number;
  /**
   * Hotspots come from 400 days of history, so a hot path may have been moved
   * or deleted since. Surfaced to the model so it does not recommend work on a
   * directory that no longer exists. Undefined when the correlation did not
   * resolve it (older reports); treated as "assume it exists".
   */
  existsAtHead?: boolean;
}

/** The per-group code context handed to the deep-dive prompt. */
export interface GroupCodeContext {
  teams: string[];
  areaHotspots: PromptHotspot[];
  fileHotspots: PromptHotspot[];
  linkedTickets: number;
  /** True when at least one supplied hotspot is known to be gone at HEAD. */
  hasStalePaths: boolean;
}

function promptHotspot(h: CodeHotspot): PromptHotspot {
  return h.existsAtHead === undefined
    ? { path: h.path, defectCount: h.defectCount }
    : { path: h.path, defectCount: h.defectCount, existsAtHead: h.existsAtHead };
}

/**
 * Rank hotspots for a prompt: paths that still exist at HEAD first, then by
 * defect count. Stale paths are kept (they are real evidence of where defects
 * came from) but demoted, and flagged so the model won't target them.
 */
function promptHotspots(hotspots: CodeHotspot[], limit: number): PromptHotspot[] {
  return [...hotspots]
    .sort((a, b) => {
      const aStale = a.existsAtHead === false ? 1 : 0;
      const bStale = b.existsAtHead === false ? 1 : 0;
      return aStale - bStale || b.defectCount - a.defectCount;
    })
    .slice(0, limit)
    .map(promptHotspot);
}

/**
 * Resolve the code context for one group: prefer the group-scoped entry (only
 * computable after synthesis), and fall back to the repo-wide teams/hotspots so
 * the prompt still has *something* real to name when the callback is absent.
 */
export function groupCodeContext(
  groupKey: string,
  byGroup: CodeCorrelation["byGroup"] | null,
  correlation: CodeCorrelation | null,
): GroupCodeContext | null {
  const entry = byGroup?.find((b) => b.groupKey === groupKey);
  const source = entry
    ? {
        teams: entry.teams.slice(0, 8),
        areaHotspots: promptHotspots(entry.areaHotspots, 8),
        fileHotspots: promptHotspots(entry.fileHotspots, 10),
        linkedTickets: entry.linkedTickets,
      }
    : correlation
      ? {
          teams: correlation.byTeam.slice(0, 8).map((t) => t.team),
          areaHotspots: promptHotspots(correlation.areaHotspots, 8),
          fileHotspots: promptHotspots(correlation.fileHotspots, 10),
          linkedTickets: correlation.linkedTickets,
        }
      : null;
  if (!source) return null;
  return {
    ...source,
    hasStalePaths: [...source.areaHotspots, ...source.fileHotspots].some(
      (h) => h.existsAtHead === false,
    ),
  };
}

interface RawRootCause {
  title?: unknown;
  explanation?: unknown;
  issueKeys?: unknown;
  exampleIssueKeys?: unknown;
  contributingFactors?: unknown;
}
interface RawDeepDive {
  analysis?: unknown;
  escapeAnalysis?: unknown;
  rootCauses?: unknown;
  subGroups?: unknown;
}
interface RawSubGroupDeepDive {
  key?: unknown;
  name?: unknown;
  rootCauses?: unknown;
}

/**
 * Normalize root causes, filtering their evidence keys against a real ticket
 * set. The model is explicitly told not to invent keys; this is the enforcement.
 */
function normalizeRootCauses(raw: unknown, validKeys: Set<string>): RootCause[] {
  const arr: RawRootCause[] = Array.isArray(raw) ? (raw as RawRootCause[]) : [];
  return arr
    .map((rc) => ({
      title: cleanStr(rc?.title, 160),
      explanation: cleanStr(rc?.explanation, 2000),
      issueKeys: uniq(
        toStringArray(rc?.issueKeys ?? rc?.exampleIssueKeys, 40).filter((k) => validKeys.has(k)),
      ).slice(0, 10),
      contributingFactors: toStringArray(rc?.contributingFactors, 300).slice(0, 8),
    }))
    .filter((rc) => rc.title.length > 0 || rc.explanation.length > 0)
    .slice(0, 8);
}

/**
 * Merge one group's deep-dive narrative onto the deterministic group. Counts,
 * membership and stats are untouched — only prose and root causes come from
 * the model, and even their evidence keys are filtered to the group's tickets.
 */
export function applyGroupDeepDive(group: DefectGroup, raw: unknown): DefectGroup {
  const r = (raw && typeof raw === "object" ? raw : {}) as RawDeepDive;
  const ownKeys = new Set(group.issueKeys);

  // Sub-group root causes, matched on key first then on name.
  const subNarrative = new Map<string, RawSubGroupDeepDive>();
  if (Array.isArray(r.subGroups)) {
    for (const s of r.subGroups as RawSubGroupDeepDive[]) {
      for (const candidate of [s?.key, s?.name]) {
        if (typeof candidate !== "string") continue;
        const k = normLabel(candidate);
        if (k && !subNarrative.has(k)) subNarrative.set(k, s);
      }
    }
  }

  return {
    ...group,
    analysis: cleanStr(r.analysis, 1100),
    escapeAnalysis: cleanStr(r.escapeAnalysis, 750),
    rootCauses: normalizeRootCauses(r.rootCauses, ownKeys),
    subGroups: group.subGroups.map((sg) => {
      const n = subNarrative.get(normLabel(sg.key)) ?? subNarrative.get(normLabel(sg.name));
      if (!n) return sg;
      return { ...sg, rootCauses: normalizeRootCauses(n.rootCauses, new Set(sg.issueKeys)) };
    }),
  };
}

// ---------------------------------------------------------------------------
// Phase 4 — prevention strategies (+ model-proposed metrics)
// ---------------------------------------------------------------------------

interface RawStrategy {
  key?: unknown;
  title?: unknown;
  detail?: unknown;
  discipline?: unknown;
  team?: unknown;
  groupKeys?: unknown;
  effort?: unknown;
  priority?: unknown;
  expectedImpact?: unknown;
  metricKeys?: unknown;
  codeAreas?: unknown;
}
interface RawProposedMetric {
  key?: unknown;
  name?: unknown;
  definition?: unknown;
  unit?: unknown;
  direction?: unknown;
  source?: unknown;
  target?: unknown;
  cadence?: unknown;
  howToMeasure?: unknown;
  relatedGroupKeys?: unknown;
}
interface RawStrategyPhase {
  strategies?: unknown;
  proposedMetrics?: unknown;
}

export interface StrategyPhaseResult {
  strategies: PreventionStrategy[];
  /** Non-automated metrics the model proposed; appended to the computed set. */
  proposedMetrics: DefectMetric[];
}

const CADENCES: readonly DefectMetric["cadence"][] = ["weekly", "monthly", "quarterly"] as const;
const METRIC_DIRECTIONS: readonly MetricDirection[] = ["down-good", "up-good"] as const;

/**
 * Normalize the strategy phase.
 *
 * Metrics are normalized first because strategies reference them: a strategy
 * may only cite a metric that actually exists after normalization, otherwise
 * the UI would render dead links to a proof point nobody can measure.
 */
export function normalizeStrategyPhase(
  raw: unknown,
  groups: DefectGroup[],
  computedMetrics: DefectMetric[],
): StrategyPhaseResult {
  const r = (raw && typeof raw === "object" ? raw : {}) as RawStrategyPhase;
  const validGroupKeys = new Set(groups.map((g) => g.key));
  const computedKeys = new Set(computedMetrics.map((m) => m.key));

  // --- proposed metrics -----------------------------------------------------
  const usedMetricKeys = new Set(computedKeys);
  const proposedMetrics: DefectMetric[] = [];
  const rawMetrics: RawProposedMetric[] = Array.isArray(r.proposedMetrics)
    ? (r.proposedMetrics as RawProposedMetric[])
    : [];
  for (const m of rawMetrics) {
    const name = cleanStr(m?.name, 160);
    const howToMeasure = cleanStr(m?.howToMeasure, 1200);
    // A proposed metric with no instrumentation instructions is a slogan, not
    // a metric — drop it rather than parking an unmeasurable row in the UI.
    if (!name || !howToMeasure) continue;
    const key = slugify(cleanStr(m?.key, 80) || name);
    if (usedMetricKeys.has(key)) continue; // dedupe against the computed set
    usedMetricKeys.add(key);
    proposedMetrics.push({
      key,
      name,
      definition: cleanStr(m?.definition, 800),
      unit: cleanStr(m?.unit, 40) || "count",
      direction: oneOf<MetricDirection>(m?.direction, METRIC_DIRECTIONS, "down-good"),
      source: oneOf<MetricSource>(m?.source, METRIC_SOURCES, "manual"),
      automated: false, // by definition: we compute the automated ones ourselves
      current: null,
      baseline: null,
      target: numOrNull(m?.target),
      cadence: oneOf<DefectMetric["cadence"]>(m?.cadence, CADENCES, "monthly"),
      series: [],
      howToMeasure,
      relatedGroupKeys: uniq(
        toStringArray(m?.relatedGroupKeys, 80).filter((k) => validGroupKeys.has(k)),
      ).slice(0, 6),
    });
  }

  const knownMetricKeys = new Set([...computedKeys, ...proposedMetrics.map((m) => m.key)]);

  // --- strategies -----------------------------------------------------------
  const usedStrategyKeys = new Set<string>();
  const rawStrategies: RawStrategy[] = Array.isArray(r.strategies) ? (r.strategies as RawStrategy[]) : [];
  const strategies: PreventionStrategy[] = [];
  for (const s of rawStrategies) {
    const title = cleanStr(s?.title, 200);
    if (!title) continue;
    const claimed = toStringArray(s?.groupKeys, 80);
    const groupKeys = uniq(claimed.filter((k) => validGroupKeys.has(k)));
    // A strategy that only cites groups we don't have is grounded in nothing
    // real — reject it. One that cites none at all is treated as cross-cutting.
    if (claimed.length > 0 && groupKeys.length === 0) continue;
    strategies.push({
      key: uniqueKey(slugify(cleanStr(s?.key, 80) || title), usedStrategyKeys),
      title,
      detail: cleanStr(s?.detail, 600),
      discipline: oneOf<PreventionDiscipline>(s?.discipline, PREVENTION_DISCIPLINES, "process"),
      team: cleanStr(s?.team, 120) || "Engineering",
      groupKeys: groupKeys.slice(0, 8),
      effort: oneOf<Effort>(s?.effort, EFFORTS, "medium"),
      priority: oneOf<ActionPriority>(s?.priority, ACTION_PRIORITIES, "next"),
      expectedImpact: cleanStr(s?.expectedImpact, 400),
      metricKeys: uniq(toStringArray(s?.metricKeys, 80).filter((k) => knownMetricKeys.has(k))).slice(
        0,
        6,
      ),
      codeAreas: uniq(toStringArray(s?.codeAreas, 200)).slice(0, 10),
    });
  }

  strategies.sort(
    (a, b) =>
      PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
      DISCIPLINE_RANK[a.discipline] - DISCIPLINE_RANK[b.discipline] ||
      a.title.localeCompare(b.title),
  );

  return { strategies, proposedMetrics };
}

// ---------------------------------------------------------------------------
// Phase 5 — per-team action plans
// ---------------------------------------------------------------------------

interface RawTeamPlan {
  team?: unknown;
  label?: unknown;
  summary?: unknown;
  issueKeys?: unknown;
  strategyKeys?: unknown;
  metricKeys?: unknown;
}

/** The deterministic team → ticket mapping the plans are built on. */
export interface TeamOwnership {
  team: string;
  issueKeys: string[];
}

/**
 * Derive team ownership from the code correlation when we have it. This is the
 * honest answer to "who owns these defects" — it comes from CODEOWNERS over the
 * files the fix commits actually touched, not from the model's guess.
 */
export function teamOwnershipFromCorrelation(correlation: CodeCorrelation): TeamOwnership[] {
  return correlation.byTeam
    .filter((t) => t.issueKeys.length > 0)
    .map((t) => ({ team: t.team, issueKeys: uniq(t.issueKeys) }))
    .sort((a, b) => b.issueKeys.length - a.issueKeys.length || a.team.localeCompare(b.team));
}

/**
 * Build the per-team plans. Ownership, counts, issue keys, top groups and top
 * areas are all deterministic; the model contributes only the `summary` and the
 * links to strategies/metrics. When no correlation exists we fall back to the
 * model's own team attribution, but still derive the counts from the keys it
 * named (filtered to real tickets) rather than trusting a number it wrote.
 */
export function normalizeTeamPlans(
  raw: unknown,
  ownership: TeamOwnership[],
  groups: DefectGroup[],
  signals: DefectSignal[],
  strategies: PreventionStrategy[],
  metrics: DefectMetric[],
  correlation: CodeCorrelation | null = null,
): TeamActionPlan[] {
  const arr: RawTeamPlan[] = Array.isArray(raw) ? (raw as RawTeamPlan[]) : [];
  const validKeys = new Set(signals.map((s) => s.issueKey));
  const validStrategyKeys = new Set(strategies.map((s) => s.key));
  const validMetricKeys = new Set(metrics.map((m) => m.key));
  const areaByKey = new Map(signals.map((s) => [s.issueKey, s.area]));
  const groupsByKey = groups.map((g) => ({ g, keys: new Set(g.issueKeys) }));

  const byTeam = new Map<string, RawTeamPlan>();
  for (const t of arr) {
    const name = cleanStr(t?.team, 120);
    if (!name) continue;
    const k = normLabel(name);
    if (!byTeam.has(k)) byTeam.set(k, t);
  }

  // No deterministic ownership → fall back to the teams the model named, with
  // their issue keys filtered against the real population.
  const effective: TeamOwnership[] =
    ownership.length > 0
      ? ownership
      : [...byTeam.entries()]
          .map(([, t]) => ({
            team: cleanStr(t?.team, 120),
            issueKeys: uniq(toStringArray(t?.issueKeys, 40).filter((k) => validKeys.has(k))),
          }))
          .filter((t) => t.team.length > 0 && t.issueKeys.length > 0)
          .sort((a, b) => b.issueKeys.length - a.issueKeys.length || a.team.localeCompare(b.team));

  return effective.map((own) => {
    const model =
      byTeam.get(normLabel(own.team)) ?? byTeam.get(normLabel(teamLabel(own.team)));
    const keys = own.issueKeys.filter((k) => validKeys.has(k));
    const keySet = new Set(keys);
    const topGroups = groupsByKey
      .map(({ g, keys: gk }) => ({
        groupKey: g.key,
        name: g.name,
        ticketCount: keys.reduce((n, k) => (gk.has(k) ? n + 1 : n), 0),
      }))
      .filter((x) => x.ticketCount > 0)
      .sort((a, b) => b.ticketCount - a.ticketCount || a.name.localeCompare(b.name))
      .slice(0, 6);
    const topAreas = topByFrequency(
      [...keySet]
        .map((k) => areaByKey.get(k) ?? null)
        .filter((x): x is string => Boolean(x)),
      6,
    );
    // Denormalized from the correlation so a team card reads standalone.
    // Left undefined when we have no git data rather than faked as 0.
    const stats = correlation?.byTeam.find((t) => t.team === own.team);
    return {
      team: own.team,
      label: cleanStr(model?.label, 80) || teamLabel(own.team),
      defectCount: keys.length,
      issueKeys: keys,
      topGroups,
      topAreas,
      summary: cleanStr(model?.summary, 650),
      strategyKeys: uniq(
        toStringArray(model?.strategyKeys, 80).filter((k) => validStrategyKeys.has(k)),
      ).slice(0, 8),
      metricKeys: uniq(
        toStringArray(model?.metricKeys, 80).filter((k) => validMetricKeys.has(k)),
      ).slice(0, 6),
      ...(stats ? { testChangeRate: stats.testChangeRate, commitCount: stats.commitCount } : {}),
    };
  });
}

// ---------------------------------------------------------------------------
// Phase 6 — per-component narrative
// ---------------------------------------------------------------------------

/**
 * Word budgets convert to character clamps at the same ~9.3 chars/word the
 * global fields use (group analysis: 120 words → 1100; group escape analysis:
 * 80 words → 750). Keeping the ratio identical means a component narrative that
 * blows its budget is truncated as hard as a group one, rather than quietly
 * being allowed twice the prose because it is one level down.
 */
const COMPONENT_SUMMARY_MAX = 840; // 90 words
const COMPONENT_ESCAPE_MAX = 560; // 60 words

interface RawComponentNarrative {
  summary?: unknown;
  escapeAnalysis?: unknown;
  strategies?: unknown;
  /** Fields the model sometimes echoes back; deliberately never read. */
  defectCount?: unknown;
  groups?: unknown;
}

export interface ComponentNarrativeOptions {
  /**
   * Metric keys a component strategy may cite, on top of the slice's own
   * recomputed metrics — normally the report-wide metric keys.
   */
  metricKeys?: readonly string[];
  /**
   * Keys already taken by the global strategies (and anything else that shares
   * the report's key namespace). Seeded into the uniqueness check so a
   * component strategy can never shadow a global one.
   */
  reservedStrategyKeys?: readonly string[];
}

/**
 * Namespace a component strategy key by its component slug.
 *
 * Component strategies live in the same flat key space as the global ones (the
 * UI links strategies by key, and a team plan cites `strategyKeys` without
 * saying where they came from), so `flaky-fixtures` proposed for Integrations
 * must not silently resolve to the global `flaky-fixtures`. The `comp-` prefix
 * plus the slug makes the origin readable in a URL and collision-proof in
 * practice; `applyComponentNarrative` still de-duplicates against the reserved
 * global keys for the pathological case.
 */
export function componentStrategyKey(slug: string, key: string): string {
  return `comp-${slugify(slug)}-${slugify(key)}`;
}

/**
 * The code context for one component: the teams that own the code its defects
 * were fixed in, and its hottest paths. Built with the same live-first,
 * stale-flagged ranking as the deep-dive so the model treats a deleted
 * directory identically in both prompts.
 */
export function componentCodeContext(slice: ComponentAnalysis): GroupCodeContext | null {
  const corr = slice.codeCorrelation;
  const teams = uniq([
    ...slice.teams.map((t) => t.team),
    ...(corr?.byTeam ?? []).map((t) => t.team),
  ]).slice(0, 8);
  const areaHotspots = promptHotspots(corr?.areaHotspots ?? [], 8);
  const fileHotspots = promptHotspots(corr?.fileHotspots ?? [], 10);
  if (teams.length === 0 && areaHotspots.length === 0 && fileHotspots.length === 0) return null;
  return {
    teams,
    areaHotspots,
    fileHotspots,
    linkedTickets: corr?.linkedTickets ?? 0,
    hasStalePaths: [...areaHotspots, ...fileHotspots].some((h) => h.existsAtHead === false),
  };
}

/**
 * The prompt payload for one component. Everything here is deterministic —
 * the model is being asked to explain numbers it cannot change.
 */
export function componentPromptPayload(
  slice: ComponentAnalysis,
  signalByKey: Map<string, DefectSignal>,
  opts: { metricKeys?: readonly string[]; reportSummary?: string } = {},
) {
  const samples = slice.issueKeys
    .map((k) => signalByKey.get(k))
    .filter((s): s is DefectSignal => Boolean(s))
    .sort((a, b) => b.severityScore - a.severityScore || a.issueKey.localeCompare(b.issueKey))
    .slice(0, 20)
    .map((s) => ({
      key: s.issueKey,
      area: s.area,
      failureMode: s.failureMode,
      symptom: s.symptom,
      suspectedRootCause: s.suspectedRootCause,
      triggerCondition: s.triggerCondition,
      escapeReason: s.escapeReason,
      detectionStage: s.detectionStage,
      trigger: s.trigger,
      isRegression: s.isRegression,
    }));
  return {
    component: {
      name: slice.component,
      slug: slice.slug,
      defectCount: slice.defectCount,
      sharePct: slice.share,
      severityAvg: slice.severityAvg,
      preventabilityAvg: slice.preventabilityAvg,
      regressionCount: slice.regressionCount,
      detectionStages: slice.detectionStages,
      triggers: slice.triggers,
      topAreas: slice.topAreas,
      topFailureModes: slice.topFailureModes,
    },
    groups: slice.groups.map((g) => ({
      groupKey: g.groupKey,
      name: g.name,
      ticketCount: g.ticketCount,
      sharePct: g.share,
      detectionStages: g.detectionStages,
      triggers: g.triggers,
    })),
    codeContext: componentCodeContext(slice),
    metricKeys: uniq([...slice.metrics.map((m) => m.key), ...(opts.metricKeys ?? [])]).slice(0, 40),
    /**
     * The report-wide summary, so the model can say something DIFFERENT rather
     * than paraphrasing the page the reader already read to get here.
     */
    reportWideSummary: cleanStr(opts.reportSummary, 600),
    samples,
  };
}

/**
 * Merge one component's model-written narrative onto its deterministic slice.
 *
 * Only `summary`, `escapeAnalysis` and `strategies` are taken from the model.
 * Every count, group slice, metric series and correlation is passed through by
 * spread — a response that tries to rewrite `defectCount` or `groups` is
 * ignored outright, because the component page renders those numbers next to
 * this prose and the two disagreeing would discredit both.
 */
export function applyComponentNarrative(
  slice: ComponentAnalysis,
  raw: unknown,
  opts: ComponentNarrativeOptions = {},
): ComponentAnalysis {
  const r = (raw && typeof raw === "object" ? raw : {}) as RawComponentNarrative;
  const validGroupKeys = new Set(slice.groups.map((g) => g.groupKey));
  const knownMetricKeys = new Set<string>([
    ...slice.metrics.map((m) => m.key),
    ...(opts.metricKeys ?? []),
  ]);
  // Paths known to be gone at HEAD must never reach `codeAreas`: an action item
  // pointed at a deleted directory costs a team a wasted investigation.
  const stalePaths = new Set(
    [
      ...(slice.codeCorrelation?.areaHotspots ?? []),
      ...(slice.codeCorrelation?.fileHotspots ?? []),
    ]
      .filter((h) => h.existsAtHead === false)
      .map((h) => h.path),
  );
  // Seeded with the global keys so `uniqueKey` treats a collision with a global
  // strategy exactly like a collision inside this component.
  const usedKeys = new Set<string>(opts.reservedStrategyKeys ?? []);
  const fallbackTeam = slice.teams[0]?.team ?? slice.codeCorrelation?.byTeam[0]?.team ?? "";

  const rawStrategies: RawStrategy[] = Array.isArray(r.strategies)
    ? (r.strategies as RawStrategy[])
    : [];
  const strategies: PreventionStrategy[] = [];
  for (const s of rawStrategies) {
    const title = cleanStr(s?.title, 200);
    if (!title) continue;
    const claimed = toStringArray(s?.groupKeys, 80);
    const groupKeys = uniq(claimed.filter((k) => validGroupKeys.has(k)));
    // Same rule as the global phase, scoped to THIS component's slices: a
    // strategy citing only groups this component does not have is grounded in
    // nothing. Citing none at all means "the whole component".
    if (claimed.length > 0 && groupKeys.length === 0) continue;
    strategies.push({
      key: uniqueKey(componentStrategyKey(slice.slug, cleanStr(s?.key, 80) || title), usedKeys),
      title,
      detail: cleanStr(s?.detail, 600),
      discipline: oneOf<PreventionDiscipline>(s?.discipline, PREVENTION_DISCIPLINES, "process"),
      team: cleanStr(s?.team, 120) || fallbackTeam || "Engineering",
      groupKeys: groupKeys.slice(0, 8),
      effort: oneOf<Effort>(s?.effort, EFFORTS, "medium"),
      priority: oneOf<ActionPriority>(s?.priority, ACTION_PRIORITIES, "next"),
      expectedImpact: cleanStr(s?.expectedImpact, 400),
      metricKeys: uniq(
        toStringArray(s?.metricKeys, 80).filter((k) => knownMetricKeys.has(k)),
      ).slice(0, 6),
      codeAreas: uniq(toStringArray(s?.codeAreas, 200).filter((p) => !stalePaths.has(p))).slice(
        0,
        5,
      ),
    });
  }
  strategies.sort(
    (a, b) =>
      PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
      DISCIPLINE_RANK[a.discipline] - DISCIPLINE_RANK[b.discipline] ||
      a.title.localeCompare(b.title),
  );

  return {
    ...slice,
    summary: cleanStr(r.summary, COMPONENT_SUMMARY_MAX),
    escapeAnalysis: cleanStr(r.escapeAnalysis, COMPONENT_ESCAPE_MAX),
    // The prompt asks for 2-4; anything past 4 is the model padding, and a
    // component page with eight actions gets none of them done.
    strategies: strategies.slice(0, 4),
  };
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

/**
 * Shared preamble. Every phase gets the same product/codebase grounding so the
 * model reasons about Veza's actual architecture instead of a generic SaaS app.
 */
const PRODUCT_CONTEXT = `PRODUCT CONTEXT — Veza is an identity-security platform. It ingests identity, permission and resource metadata from customer systems and builds an authorization graph customers query and monitor.

The source is a Go + TypeScript monorepo (cookieai-core) with roughly these layers:
- connectors/agents that pull identity + permission data from 3rd-party systems (Okta, AD, AWS, Azure, GCP, Snowflake, Salesforce, ServiceNow, Workday, SAP, Databricks, Postgres, MySQL, MongoDB, Kubernetes, GitHub, Box, CyberArk, HashiCorp Vault, …), usually via paged REST/SQL APIs under OAuth/token/service-account auth;
- a control plane that schedules and configures those extractions per tenant;
- a graph/data backend that transforms extracted entities into the authorization graph and serves queries;
- a frontend (workflows, reports, access reviews, dashboards);
- lifecycle-management services (access requests, provisioning, remediation, notifications).

Defects therefore concentrate in recognizable mechanisms: auth/token lifecycle and refresh, pagination and incremental/delta sync, schema drift in 3rd-party payloads, rate limiting and throttling, partial failure and retry semantics, very large tenants (millions of entities) hitting memory/timeout/pagination limits, concurrency between scheduled jobs, upgrade/migration ordering, permission/entitlement modelling edge cases, and UI/API contract drift.`;

const EVIDENCE_RULES = `EVIDENCE RULES (violating these makes the output worthless):
- Ground every claim in the supplied evidence. Never invent a ticket key; only echo keys that appear in the input.
- Name concrete mechanisms — "the OAuth refresh token is fetched per worker so concurrent syncs invalidate each other", "the cursor is stored before the page is committed so a mid-page failure skips records", "the connector assumes the group-membership array is present and panics when the tenant has none".
- Banned as output: "improve testing", "add more tests", "better error handling", "enhance monitoring", "increase code review rigor", and any sentence that would be equally true of any software product. If you cannot be specific, say what evidence is missing instead.
- Prefer the smallest true statement over a confident generalization.`;

const EXTRACT_SYSTEM = `You are a principal engineer at Veza performing DEFECT ESCAPE ANALYSIS on customer-found defects. Every ticket you are reading is a bug a paying customer hit in production — which means every one of them got past our design reviews, code reviews, tests, QA and staging.

${PRODUCT_CONTEXT}

For EACH ticket, read the summary, description AND comments (the comments usually contain the real diagnosis) and emit ONE JSON object. Fill EVERY field — a field you leave out becomes a hole in the population-level analysis.

Fields:
- issueKey: string, echoed EXACTLY as given. Never emit a key that was not in the input.
- area: the Veza product area in our own terms, e.g. "Okta connector", "AWS connector", "Graph ingestion", "Access reviews", "Provisioning", "Query API", "Frontend — reports", "Scheduler". null only if genuinely indeterminable.
- failureMode: SHORT reusable phrase naming the technical failure pattern, e.g. "Pagination cursor expiry", "Token refresh race", "Schema drift on nested attribute", "OOM on large tenant sync", "Partial write leaves orphaned edges". Reuse identical phrasing across tickets that share a pattern — consistency is what lets us count patterns.
- symptom: one sentence on what the CUSTOMER observed.
- suspectedRootCause: one sentence naming the underlying defect in our code/design. Say "Undetermined" only when the ticket truly does not say.
- triggerCondition: the specific condition that had to hold for this to fire, e.g. "tenant with >200k groups", "customer using SAML-only Okta org", "sync running concurrently with a scheduled full refresh", "upgrade from 2024.4 to 2025.1 with pending migrations".
- trigger: EXACTLY one of: ${DEFECT_TRIGGERS.join(" | ")}.
- escapeReason: one or two sentences explaining WHY OUR OWN GATES MISSED IT. Be concrete about the gap: "our integration fixtures only cover a single page of results", "we have no test tenant with nested OUs", "the migration path was never exercised because CI always starts from a clean schema", "the code path is only reachable when the customer disables an optional feature". This is the most important field.
- detectionStage: the EARLIEST gate that realistically SHOULD have caught it. EXACTLY one of: ${DETECTION_STAGES.filter((s) => s !== "unclassified").join(
    " | ",
  )}. Use "not-preventable" ONLY for genuinely unforeseeable causes (an undocumented 3rd-party API change, a customer infrastructure failure) — it is a deliberate judgement, not a shrug. Never emit "unclassified"; that value is reserved for tickets we failed to process.
- errorSignatures: 0-5 short verbatim error strings, HTTP codes, exception types or log lines from the ticket. Empty array if none.
- category: a SHORT reusable TOP-LEVEL category, describing the KIND of defect rather than the product area, e.g. "Data ingestion correctness", "Authentication & credential lifecycle", "Scale & performance", "Upgrade & migration", "Permission modelling", "UI/UX correctness", "API contract", "Alerting & notification". Reuse identical wording across tickets.
- subCategory: a SHORT reusable second-level label WITHIN that category, e.g. under "Data ingestion correctness": "Pagination & cursors", "Delta/incremental sync", "Schema drift", "Partial failure handling". Reuse identical wording.
- isRegression: true if the ticket indicates this used to work and broke in a release/upgrade.
- customerImpact: one sentence on the business consequence for the customer (blocked access review, stale entitlements, missing data in reports, failed provisioning, …).
- severityScore: integer 1-10, customer/business impact.
- preventability: integer 1-10, how preventable this was with better engineering practice (10 = we absolutely should have caught this; 1 = essentially unforeseeable).

${EVIDENCE_RULES}

Return ONLY a JSON array of these objects inside a \`\`\`json fence. No prose.`;

const SYNTHESIS_SYSTEM = `You are a principal engineer building the canonical TAXONOMY of customer-found defects for Veza's engineering leadership. This is a population-level pattern analysis, NOT per-ticket triage.

${PRODUCT_CONTEXT}

You are given CATEGORY ROLLUPS: tickets already grouped by the raw category label assigned during extraction. Each rollup carries a count, its raw sub-category labels with counts, top product areas, top failure modes, the distribution of detection stages and triggers, average severity and preventability, and a sample of representative tickets.

Your job is to merge these raw labels into a clean TWO-LEVEL taxonomy and write the executive summary.

CRITICAL — do NOT enumerate ticket keys, counts, shares or percentages anywhere. Ticket membership and every number are computed mechanically from the rollups. You decide ONLY how raw labels group and what the groups are called. Numbers you write will be discarded.

Taxonomy rules:
- Return 6-12 top-level groups. This is a hard requirement, not a suggestion: anything beyond ${MAX_TOP_LEVEL_GROUPS} groups is truncated into a catch-all bucket, so an over-fragmented taxonomy loses information. Each group is a KIND of defect with a shared prevention story — if two candidate groups would be fixed by the same engineering change, merge them.
- Every raw category label must appear under EXACTLY ONE group. Do not place a label twice, and DO NOT LEAVE A LABEL OUT — every label you omit is dumped into an "${REMAINDER_GROUP_NAME}" bucket, which is a failure of this task. Low-volume and oddly-named labels still belong somewhere; find the group whose mechanism they share.
- Within each group, define 2-5 sub-groups, and assign the group's raw SUB-category labels to them. Same rule: each raw sub-category label under at most one sub-group.
- Group names should be concrete and mechanism-flavoured ("Incremental sync correctness", "Credential & token lifecycle", "Large-tenant scale limits", "Upgrade & migration ordering") — not organizational ("Backend bugs") and not vague ("Miscellaneous").

Output ONE JSON object:
- executiveSummary: markdown, AT MOST 150 WORDS, for engineering leadership. Structure it as one 2-sentence lead naming the dominant escape pattern, then 3-4 single-line bullets: the biggest groups and the mechanism they share, the highest-leverage prevention theme, and what the regression/preventability numbers say. Ruthlessly concise — every sentence must carry a fact a reader would act on. No preamble, no restating the brief, no listing evidence the sections below already carry. If you find yourself writing a clause that only sets up the next one, delete it.
- groups: array. Each:
   * name: canonical group name.
   * description: 1-3 sentences on what belongs in this group and what mechanism it concerns.
   * mergesCategories: array of the EXACT raw category labels from the rollups that belong to this group.
   * subGroups: array of 2-5. Each: name, description (1-2 sentences), mergesSubCategories (array of EXACT raw sub-category labels from this group's rollups).

${EVIDENCE_RULES}

Return ONLY the JSON object inside a \`\`\`json fence. No prose.`;

/**
 * Second-pass placement. Cheap, narrow, and run only when the first synthesis
 * left labels on the floor — we re-ask about the tail instead of redoing the
 * whole taxonomy, which is what kept the real run's 28 groups from happening.
 */
const PLACEMENT_SYSTEM = `You are finishing a defect taxonomy for Veza. A first pass produced the canonical groups below but failed to place some raw category labels. Assign each leftover label to the ONE existing group whose failure mechanism it shares.

${PRODUCT_CONTEXT}

Rules:
- Use ONLY the group names given to you, verbatim. Do not invent, rename or merge groups.
- Assign every leftover label. A label with only 1-2 tickets still belongs to whichever group shares its mechanism — small volume is not a reason to refuse.
- Answer "none" ONLY when a label genuinely shares no mechanism with any group. Every "none" ends up in an undifferentiated catch-all bucket, so use it sparingly.
- Judge by mechanism (what breaks and why), not by wording overlap with the group name.

Output ONE JSON object:
- assignments: array with one entry per leftover label. Each: label (the EXACT leftover label as given), group (the EXACT canonical group name, or "none").

Return ONLY the JSON object inside a \`\`\`json fence. No prose.`;

const DEEP_DIVE_SYSTEM = `You are a principal engineer writing the deep-dive section for ONE group in Veza's customer-found defect analysis. Engineers on the owning team will read this and be expected to act on it.

${PRODUCT_CONTEXT}

You are given: the group's name and description, its deterministic statistics (ticket count, share, average severity and preventability, regression count, detection-stage distribution, trigger distribution, top product areas), its sub-groups, a sample of its ticket signals (failure mode, symptom, suspected root cause, trigger condition, escape reason, error signatures), and — when available — CODE CONTEXT: the CODEOWNERS teams and the hottest directories/files that this group's fix commits actually touched.

STALE PATHS: hotspots are derived from ~400 days of git history, so some no longer exist. Any hotspot with \`"existsAtHead": false\` has since been moved or deleted. You may cite such a path when explaining HISTORY ("the failures clustered in the old lifecycle_management package before it was split"), but never describe it as current code and never point remediation at it. When both a live and a stale path could make the point, use the live one.

A \`detectionStage\` of "unclassified" means extraction failed to judge that ticket — it is missing data, NOT a finding. Exclude it from your reasoning about which gate is weakest, and if it dominates the distribution, say the sample is too thin to conclude rather than inventing a gap.

Produce ONE JSON object:
- analysis: markdown, AT MOST 120 WORDS. WHAT fails, HOW it fails mechanically, and WHY the design permits it. Name the real failure path and the real directories/files from the code context. Cite at most 3 ticket keys as evidence — the drilldown carries the rest. Prefer one dense paragraph or 3-4 tight bullets over prose. Do not restate the group's statistics back to the reader; they are rendered next to this text. Do not narrate what you are about to say.
- escapeAnalysis: markdown, AT MOST 80 WORDS. WHY OUR GATES MISSED THIS CLASS, using the detection-stage distribution as the spine: name exactly what today's tests do not cover (which fixtures, tenant shapes, API behaviours) and the structural reason — e.g. "connector fixtures are recorded from a small sandbox tenant, so no test crosses a page boundary". One or two sentences plus at most two examples. Do not repeat the mechanism already covered in the analysis field; this one answers only why it escaped.
- rootCauses: array of 2-5. Each:
   * title: short, mechanism-named ("Cursor persisted before page commit").
   * explanation: markdown, 2-4 sentences on the underlying cause and why it recurs.
   * contributingFactors: 2-5 short strings (design decisions, missing fixtures, ownership boundaries, 3rd-party behaviours).
   * issueKeys: 0-4 ticket keys from THIS group's samples that evidence it. Never invent a key.
- subGroups: array, one entry per sub-group you were given that you have something specific to say about. Each: key (the sub-group key exactly as given), rootCauses (same shape as above, 1-3 entries, issueKeys drawn only from that sub-group).

${EVIDENCE_RULES}

Return ONLY the JSON object inside a \`\`\`json fence. No prose.`;

const STRATEGY_SYSTEM = `You are a principal engineer proposing the PREVENTION PROGRAMME that follows from Veza's customer-found defect analysis. The audience is engineering leadership deciding what to fund next quarter.

${PRODUCT_CONTEXT}

You are given: every defect group with its key, name, description, ticket count, share, detection-stage and trigger distributions, average preventability, regression count and escape analysis; the CODEOWNERS teams that own the defective code, with their defect counts and how often their fix commits included a test change; the hottest code areas; and the metric keys this dashboard already computes automatically.

STALE PATHS: the hot code areas come from ~400 days of git history and are listed live-first. Any entry with \`"existsAtHead": false\` has been moved or deleted since — do NOT put it in \`codeAreas\` and do NOT write a strategy whose work item targets it. A ticket telling a team to go harden a directory that no longer exists is worse than no ticket. If the only hot path for a real pattern is stale, say so in \`detail\` and scope the work to wherever that code lives now.

A \`detectionStage\` of "unclassified" is missing data, not a gap. Never size a strategy off the unclassified bucket.

Produce ONE JSON object:
- strategies: array of 10-18 concrete prevention actions. COVER ALL EIGHT disciplines — ${PREVENTION_DISCIPLINES.join(", ")} — with at least one strategy each, and weight the number of strategies per discipline by where the detection-stage distribution says the gaps actually are. Each strategy:
   * key: short kebab-case identifier.
   * title: imperative and specific ("Record connector fixtures from a multi-page tenant and assert cursor resumption").
   * detail: markdown, AT MOST 55 WORDS. Exactly WHAT to build or change, WHERE (name real directories/files from the code areas when they apply), and WHY it closes the specific gap. An engineer should be able to open a ticket from this — so keep the specifics and cut the justification prose.
   * discipline: EXACTLY one of ${PREVENTION_DISCIPLINES.join(" | ")}.
   * team: the owning team. STRONGLY prefer one of the CODEOWNERS team slugs you were given, verbatim. Only use an engineering function name ("Quality Engineering", "Platform", "Release Engineering") when no supplied team owns this work.
   * groupKeys: array of the defect group keys this addresses, using the EXACT keys given. Empty only for genuinely cross-cutting work.
   * effort: "low" | "medium" | "high".
   * priority: "now" | "next" | "later" — driven by ticket volume × preventability, not by how interesting the work is.
   * expectedImpact: markdown, 1-3 sentences naming the defects this would have prevented and roughly how many, referencing the group statistics you were given.
   * metricKeys: array of metric keys that would prove this worked. Use the EXISTING metric keys you were given wherever one fits; otherwise use a key you define in proposedMetrics.
   * codeAreas: 0-5 real code paths from the supplied hotspots that this touches.
- proposedMetrics: array of 0-6 ADDITIONAL metrics that are not in the existing set and that we cannot compute today. Each: key (kebab-case), name, definition, unit, direction ("down-good" | "up-good"), source ("jira" | "code" | "ci" | "runtime" | "manual"), cadence ("weekly" | "monthly" | "quarterly"), target (number or null), relatedGroupKeys (exact group keys), howToMeasure (markdown: the concrete instrumentation — which system emits it, what to count, what to divide by). A proposed metric without real instrumentation instructions is worthless; omit it instead.

${EVIDENCE_RULES}

Return ONLY the JSON object inside a \`\`\`json fence. No prose.`;

const TEAMS_SYSTEM = `You are a principal engineer writing the per-team section of Veza's customer-found defect analysis. Each team lead will read only their own entry.

${PRODUCT_CONTEXT}

You are given, per team: the CODEOWNERS team slug, the number of customer-found defects whose fixes touched code they own, the share of their fix commits that also changed a test, their dominant defect groups, their top product areas, and a sample of their defect signals. You are also given the full strategy list (keys, titles, disciplines, owning teams) and the available metric keys.

CRITICAL — do NOT invent or restate counts, percentages or ticket keys. Every number is computed mechanically and any you write will be discarded.

Produce ONE JSON array, one object per team you were given:
- team: the team slug EXACTLY as given.
- label: a short human label for the team.
- summary: markdown, AT MOST 70 WORDS written TO that team. Two or three sentences: which mechanism keeps failing and which gate keeps missing it, what is distinctive about them versus the rest of engineering (low test-change rate on fixes, concentration in one trigger, high regression count), and the single change that would move their numbers most. Their counts and assigned actions are rendered around this text — do not restate them. No encouragement filler, no preamble.
- strategyKeys: the keys of the strategies this team should own or contribute to, drawn EXACTLY from the strategy list.
- metricKeys: the metric keys this team should watch, drawn EXACTLY from the supplied keys.

${EVIDENCE_RULES}

Return ONLY the JSON array inside a \`\`\`json fence. No prose.`;

const COMPONENT_SYSTEM = `You are a principal engineer writing the drilldown page for ONE JIRA COMPONENT in Veza's customer-found defect analysis. The reader is the engineering manager who owns this component; they have already read the report-wide summary and clicked through because they want to know what is wrong with THEIR area specifically.

${PRODUCT_CONTEXT}

You are given, for this component only: its name, its deterministic statistics (defect count, share of all defects, average severity and preventability, regression count, detection-stage distribution, trigger distribution, top product areas, top failure modes), the report-wide defect groups as they appear WITHIN this component (group key, name, count, and that slice's own detection-stage and trigger distributions), a sample of its defect signals, the metric keys available to cite, the report-wide executive summary, and — when available — CODE CONTEXT: the CODEOWNERS teams and hottest directories/files that THIS component's fix commits touched.

CRITICAL — every number and every group membership is computed mechanically. Do not restate counts, shares, averages or percentages: they are rendered next to your text. Numbers you write will be discarded. Never invent a ticket key; echo only keys from the samples.

SPECIFICITY IS THE WHOLE POINT. The report-wide summary is given to you so you can say something ELSE. A summary that would be equally true of any other component is a failure — it must name this component's own mechanism and its own paths.

STALE PATHS: hotspots come from ~400 days of git history. Any hotspot with \`"existsAtHead": false\` has since been moved or deleted. Cite it only when explaining history, never as current code, and never target remediation at it or list it in \`codeAreas\`. When a live path makes the same point, use the live one.

A \`detectionStage\` of "unclassified" means extraction failed to judge that ticket — missing data, NOT a finding. Exclude it when reasoning about which gate is weakest; if it dominates this component's distribution, say the sample is too thin to conclude rather than inventing a gap.

Produce ONE JSON object:
- summary: markdown, AT MOST 90 WORDS. What fails in THIS component and the mechanism that permits it — the specific subsystem, the specific failure path, named against the real directories/files in the code context. One dense paragraph or 3 tight bullets. At most 2 ticket keys. No preamble, no restating the group names back, no sentence that only sets up the next one.
- escapeAnalysis: markdown, AT MOST 60 WORDS. Which gate keeps missing THIS component's defects, per ITS OWN detection-stage distribution, and the concrete fixture/environment gap behind it — which fixture, which tenant shape, which 3rd-party behaviour is absent from our test estate. Name the gap, not the discipline.
- strategies: array of 2-4 actions scoped to THIS component. Each:
   * key: short kebab-case identifier, unique within this component.
   * title: imperative and specific ("Record an Okta fixture with nested OUs and assert group expansion").
   * detail: markdown, AT MOST 55 WORDS. Exactly WHAT to build or change and WHERE, naming real live paths from the code context. An engineer should be able to open a ticket from this.
   * discipline: EXACTLY one of ${PREVENTION_DISCIPLINES.join(" | ")}.
   * team: the owning team. STRONGLY prefer one of the CODEOWNERS team slugs in this component's code context, verbatim. Use an engineering function name only when none of them owns this work.
   * groupKeys: array of group keys from THIS component's group slices, using the EXACT keys given. Empty only when the action covers the whole component.
   * effort: "low" | "medium" | "high".
   * priority: "now" | "next" | "later" — driven by this component's volume × preventability.
   * expectedImpact: 1-2 sentences naming which of this component's defects it would have prevented.
   * metricKeys: 0-3 keys from the supplied metric keys that would prove it worked. Omit rather than invent.
   * codeAreas: 0-5 real, LIVE paths from this component's code context.

${EVIDENCE_RULES}

Return ONLY the JSON object inside a \`\`\`json fence. No prose.`;

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export type AnalyzePhase =
  | "extract"
  | "synthesize"
  | "deep-dive"
  | "strategies"
  | "teams"
  | "components";

export interface AnalyzeOptions {
  model?: string;
  batchSize?: number;
  parallel?: number;
  onProgress?: (e: { phase: AnalyzePhase; done: number; total: number }) => void;
  /** Injectable for tests. Defaults to the real Anthropic JSON completion. */
  complete?: CompletionFn;
  /** Deterministic git/CODEOWNERS correlation, when available. */
  correlation?: CodeCorrelation | null;
  /** Deterministic metrics computed from ticket history, for the strategy phase. */
  metrics?: DefectMetric[];
  /** Recorded on the report for reproducibility. */
  jql?: string;
  /**
   * Signals already extracted on a previous run, keyed by issueKey. Tickets
   * present here are NOT re-sent to the model. Extraction of the real ~1300
   * ticket population takes two hours; losing it to an interrupted run is not
   * acceptable, so a resumed run only pays for the remainder.
   */
  cachedSignals?: DefectSignal[];
  /**
   * Called after each extraction batch normalizes, with that batch's signals,
   * so the caller can checkpoint them. Throwing does not abort the run.
   */
  onSignalsBatch?: (signals: DefectSignal[]) => void;
  /** Resolves per-group code ownership/hotspots once synthesis has produced the taxonomy. */
  correlationForGroups?: (
    groups: Array<{ key: string; issueKeys: string[] }>,
  ) => CodeCorrelation["byGroup"];
  /**
   * Deterministic per-JIRA-component slices to narrate. Called after the
   * taxonomy exists — the slices bucket each component's defects by the
   * report-wide groups, so they cannot be computed before synthesis — and
   * returns slices with `summary`, `escapeAnalysis` and `strategies` unset.
   * Absent or throwing ⇒ no component phase at all.
   */
  componentSlices?: (signals: DefectSignal[], groups: DefectGroup[]) => ComponentAnalysis[];
  /**
   * The previous report's taxonomy. Synthesis re-derives group names from
   * scratch every run, and the model rewords freely — measured on identical
   * data 11 minutes apart, 92% of tickets changed group KEY purely through
   * renames ("Ingestion & extraction correctness" → "Extraction ingestion
   * correctness"). Seeding the prior taxonomy into the prompt plus the
   * deterministic reconciliation in `reconcileGroupKeys` keeps keys stable
   * across runs, which is what makes any cross-run comparison (trends,
   * strategy follow-through, metric keys like `group-…`) meaningful.
   */
  priorGroups?: Array<{ key: string; name: string; description?: string; issueKeys: string[] }>;
}

/**
 * Deterministically adopt the prior report's key + name for any new group that
 * is evidently the same population: Jaccard overlap of issueKeys ≥ 0.5, matched
 * greedily best-first so a split group keeps the old identity on its larger
 * half. Prompt seeding makes the model cooperate most of the time; this is the
 * guarantee for when it doesn't. Genuinely new groups keep their new identity.
 */
export function reconcileGroupKeys(
  groups: DefectGroup[],
  prior: Array<{ key: string; name: string; issueKeys: string[] }>,
): DefectGroup[] {
  if (prior.length === 0 || groups.length === 0) return groups;
  const priorSets = prior.map((p) => ({ ...p, set: new Set(p.issueKeys) }));
  // All candidate (new, prior) pairs above threshold, best overlap first.
  const pairs: Array<{ gi: number; pi: number; jaccard: number }> = [];
  groups.forEach((g, gi) => {
    const gSet = new Set(g.issueKeys);
    priorSets.forEach((p, pi) => {
      let inter = 0;
      for (const k of gSet) if (p.set.has(k)) inter++;
      const union = gSet.size + p.set.size - inter;
      const jaccard = union === 0 ? 0 : inter / union;
      if (jaccard >= 0.5) pairs.push({ gi, pi, jaccard });
    });
  });
  pairs.sort((a, b) => b.jaccard - a.jaccard);

  const out = groups.map((g) => ({ ...g }));
  const usedNew = new Set<number>();
  const usedPrior = new Set<number>();
  const takenKeys = new Set(groups.map((g) => g.key));
  for (const { gi, pi } of pairs) {
    if (usedNew.has(gi) || usedPrior.has(pi)) continue;
    const p = priorSets[pi];
    // Never create a duplicate key: if another (unmatched) new group already
    // holds the prior key, leave both as they are.
    if (p.key !== out[gi].key && takenKeys.has(p.key)) continue;
    usedNew.add(gi);
    usedPrior.add(pi);
    takenKeys.delete(out[gi].key);
    takenKeys.add(p.key);
    out[gi].key = p.key;
    out[gi].name = p.name;
  }
  return out;
}

export function emptyProductDefectAnalysis(totalTickets = 0, jql = ""): ProductDefectAnalysis {
  return {
    generatedAt: new Date().toISOString(),
    jql,
    totalTickets,
    analyzedTickets: 0,
    executiveSummary:
      totalTickets === 0
        ? "_No tickets matched the configured JQL._"
        : "_No analyzable signal was extracted from the matched tickets._",
    groups: [],
    strategies: [],
    metrics: [],
    teamPlans: [],
    codeCorrelation: null,
    signals: [],
    components: [],
  };
}

/**
 * Fixed-size worker pool. Used by both fan-out phases so a 1300-ticket run
 * keeps a bounded number of model calls in flight; results are written back by
 * index so ordering is deterministic regardless of completion order.
 */
async function runPool<I, O>(
  items: I[],
  parallel: number,
  fn: (item: I, index: number) => Promise<O>,
  onDone?: (done: number, total: number) => void,
): Promise<O[]> {
  const out: O[] = new Array(items.length);
  let next = 0;
  let finished = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const idx = next++;
      if (idx >= items.length) return;
      out[idx] = await fn(items[idx], idx);
      finished++;
      onDone?.(finished, items.length);
    }
  }
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(parallel, items.length)) }, () => worker()),
  );
  return out;
}

const today = () => new Date().toISOString().slice(0, 10);

/**
 * Six-phase population-level defect analysis:
 *   1. extract    — one signal per ticket (batched, bounded parallelism).
 *   2. synthesize — the canonical two-level taxonomy + executive summary.
 *   3. deep-dive  — per group: what fails, why it escaped, root causes.
 *   4. strategies — prevention programme across all disciplines (+ metrics).
 *   5. teams      — per-team action plans, counted from the code correlation.
 *   6. components — per-JIRA-component narrative over deterministic slices.
 *
 * Every phase degrades to an empty result on failure rather than aborting the
 * run: a 1300-ticket analysis is expensive enough that losing it to one
 * overloaded API call would be unacceptable.
 */
export async function analyzeProductDefects(
  issues: JiraIssue[],
  opts: AnalyzeOptions = {},
): Promise<ProductDefectAnalysis> {
  const model = opts.model || defaultModel();
  const complete: CompletionFn = opts.complete ?? jsonCompletion;
  const batchSize = opts.batchSize ?? 8;
  const parallel = Math.max(1, opts.parallel ?? 3);
  const jql = opts.jql ?? "";
  const correlation = opts.correlation ?? null;
  const computedMetrics = opts.metrics ?? [];

  if (issues.length === 0) return emptyProductDefectAnalysis(0, jql);

  // --- Phase 1: extraction (resumable) --------------------------------------
  // Anything already extracted on a previous run is reused verbatim. Cached
  // signals for tickets no longer in the population are ignored rather than
  // smuggled into the report.
  const inPopulation = new Set(issues.map((i) => i.key));
  const cached = new Map<string, DefectSignal>();
  for (const s of opts.cachedSignals ?? []) {
    if (inPopulation.has(s.issueKey)) cached.set(s.issueKey, s);
  }
  const pending = issues.filter((i) => !cached.has(i.key));

  const bySignalKey = new Map<string, DefectSignal>(cached);
  if (pending.length > 0) {
    const batches = batchIssues(pending, batchSize);
    // Progress is reported over the WHOLE population, not just the remainder,
    // so a resumed run picks up where the UI left off instead of restarting
    // at 0 and looking like the two hours were thrown away.
    let extracted = cached.size;
    opts.onProgress?.({ phase: "extract", done: extracted, total: issues.length });
    const chunks = await runPool(batches, parallel, async (batch, idx) => {
      const user = `Today is ${today()}. Distill the following ${
        batch.length
      } customer-found defect tickets from JIRA project EAC.\n\n${batch
        .map(compactIssue)
        .join("\n---\n")}`;
      let raw: unknown = [];
      try {
        raw = await complete<unknown>({
          model,
          system: EXTRACT_SYSTEM,
          user,
          systemCacheable: true,
          maxTokens: 12000,
        });
      } catch (err) {
        console.warn(
          `[product-defects] extraction batch ${idx} failed:`,
          err instanceof Error ? err.message : err,
        );
        raw = [];
      }
      // Even on failure we normalize: the batch's tickets get default signals
      // so the population stays complete and counts stay honest.
      const batchSignals = normalizeSignals(raw, batch);
      // Checkpoint immediately. A checkpoint that throws must not cost us the
      // batch we just paid two minutes of Opus for.
      try {
        opts.onSignalsBatch?.(batchSignals);
      } catch (err) {
        console.warn(
          `[product-defects] signal checkpoint for batch ${idx} failed:`,
          err instanceof Error ? err.message : err,
        );
      }
      extracted += batchSignals.length;
      opts.onProgress?.({ phase: "extract", done: extracted, total: issues.length });
      return batchSignals;
    });
    for (const s of chunks.flat()) bySignalKey.set(s.issueKey, s);
  }

  // Merge cached + fresh back into issue order so every downstream sample,
  // rollup and key list is stable across a resume.
  const signals = issues
    .map((i) => bySignalKey.get(i.key))
    .filter((s): s is DefectSignal => Boolean(s));
  if (signals.length === 0) return emptyProductDefectAnalysis(issues.length, jql);

  // --- Phase 2: synthesis ---------------------------------------------------
  opts.onProgress?.({ phase: "synthesize", done: 0, total: 1 });
  const rollups = rollupByCategory(signals);
  // Seed the previous run's taxonomy so group identity survives re-runs. The
  // instruction lives here rather than in the system prompt so the cacheable
  // system block stays byte-identical across runs.
  const priorTaxonomy = (opts.priorGroups ?? [])
    .map((g) => ({ name: g.name, description: g.description ?? "" }))
    .filter((g) => g.name && g.name !== REMAINDER_GROUP_NAME);
  const priorBlock =
    priorTaxonomy.length > 0
      ? `\n\nEXISTING TAXONOMY (from the previous run). Reuse these group names VERBATIM wherever the concept matches — renaming an unchanged concept breaks every trend that keys off the group. Add a new group only for a pattern this taxonomy does not cover, and drop one only if nothing belongs in it:\n${JSON.stringify(
          priorTaxonomy,
        )}`
      : "";
  const synthUser = `Today is ${today()}. ${signals.length} customer-found defects were grouped into ${
    rollups.length
  } raw categories during extraction. Merge them into the canonical taxonomy.${priorBlock}\n\n${rollups
    .map((r) => JSON.stringify(r))
    .join("\n")}`;
  let synthRaw: unknown = {};
  try {
    synthRaw = await complete<unknown>({
      model,
      system: SYNTHESIS_SYSTEM,
      user: synthUser,
      systemCacheable: true,
      maxTokens: 20000,
    });
  } catch (err) {
    console.warn(
      "[product-defects] synthesis failed:",
      err instanceof Error ? err.message : err,
    );
    synthRaw = {};
  }
  // Second-pass placement, still inside the `synthesize` phase: the first pass
  // routinely leaves labels unplaced, and without this every stray label became
  // its own singleton group (the real run produced 28). One cheap extra call
  // over ONLY the leftovers; a failure just falls through to the remainder
  // bucket, which is strictly better than what we had.
  const unplaced = unplacedCategoryLabels(synthRaw, signals);
  const canonical = Array.isArray((synthRaw as RawSynthesis)?.groups)
    ? ((synthRaw as RawSynthesis).groups as RawGroup[])
        .map((g) => ({
          name: cleanStr(g?.name, 120),
          description: cleanStr(g?.description, 400),
        }))
        .filter((g) => g.name.length > 0)
    : [];
  let assignments: LabelAssignment[] = [];
  if (unplaced.length > 0 && canonical.length > 0) {
    try {
      const placementRaw = await complete<unknown>({
        model,
        system: PLACEMENT_SYSTEM,
        user: `Today is ${today()}. Place these ${unplaced.length} leftover category labels into the existing groups.\n\nCANONICAL GROUPS:\n${JSON.stringify(
          canonical,
        )}\n\nLEFTOVER LABELS:\n${JSON.stringify(unplaced)}`,
        systemCacheable: true,
        maxTokens: 4000,
      });
      assignments = normalizeAssignments(placementRaw);
    } catch (err) {
      console.warn(
        "[product-defects] second-pass label placement failed:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  const synth = normalizeSynthesis(synthRaw, signals, { assignments });
  // Reconcile BEFORE anything downstream keys off the taxonomy — deep-dives,
  // strategies, team plans and component slices all reference group keys.
  synth.groups = reconcileGroupKeys(synth.groups, opts.priorGroups ?? []);
  const bucket = synth.groups.find((g) => g.name === REMAINDER_GROUP_NAME);
  if (bucket) {
    console.warn(
      `[product-defects] ${bucket.ticketCount} tickets (${bucket.share}%) landed in the remainder bucket across ${unplaced.length} unplaced labels`,
    );
  }
  opts.onProgress?.({ phase: "synthesize", done: 1, total: 1 });

  // Per-group code correlation only becomes computable now that the taxonomy
  // exists; ask the caller to resolve it, tolerating a throwing callback.
  let byGroup: CodeCorrelation["byGroup"] | null = null;
  if (opts.correlationForGroups) {
    try {
      byGroup = opts.correlationForGroups(
        synth.groups.map((g) => ({ key: g.key, issueKeys: g.issueKeys })),
      );
    } catch (err) {
      console.warn(
        "[product-defects] per-group correlation failed:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  // --- Phase 3: per-group deep dive ----------------------------------------
  const signalByKey = new Map(signals.map((s) => [s.issueKey, s]));
  let groups = synth.groups;
  if (groups.length > 0) {
    opts.onProgress?.({ phase: "deep-dive", done: 0, total: groups.length });
    groups = await runPool(
      groups,
      // Deep dives are long generations; keep at most 3 in flight regardless of
      // the extraction parallelism the caller asked for.
      Math.min(3, parallel),
      async (group) => {
        const sample = group.issueKeys
          .map((k) => signalByKey.get(k))
          .filter((s): s is DefectSignal => Boolean(s))
          .sort((a, b) => b.severityScore - a.severityScore || a.issueKey.localeCompare(b.issueKey))
          .slice(0, 24)
          .map((s) => ({
            key: s.issueKey,
            area: s.area,
            failureMode: s.failureMode,
            symptom: s.symptom,
            suspectedRootCause: s.suspectedRootCause,
            triggerCondition: s.triggerCondition,
            escapeReason: s.escapeReason,
            detectionStage: s.detectionStage,
            trigger: s.trigger,
            isRegression: s.isRegression,
            errors: s.errorSignatures,
          }));
        const payload = {
          group: {
            key: group.key,
            name: group.name,
            description: group.description,
            ticketCount: group.ticketCount,
            sharePct: group.share,
            severityAvg: group.severityAvg,
            preventabilityAvg: group.preventabilityAvg,
            regressionCount: group.regressionCount,
            detectionStages: group.detectionStages,
            triggers: group.triggers,
            topAreas: group.topAreas,
          },
          subGroups: group.subGroups.map((sg) => ({
            key: sg.key,
            name: sg.name,
            description: sg.description,
            ticketCount: sg.ticketCount,
            sharePct: sg.share,
            topAreas: sg.topAreas,
            // Per-sub-group escape axes: this is what lets the model say the
            // gates differ between sub-groups instead of blurring them.
            detectionStages: sg.detectionStages,
            triggers: sg.triggers,
            regressionCount: sg.regressionCount,
            sampleKeys: sg.issueKeys.slice(0, 8),
          })),
          codeContext: groupCodeContext(group.key, byGroup, correlation),
          samples: sample,
        };
        let raw: unknown = {};
        try {
          raw = await complete<unknown>({
            model,
            system: DEEP_DIVE_SYSTEM,
            user: `Today is ${today()}. Deep-dive the defect group "${group.name}".\n\n${JSON.stringify(
              payload,
            )}`,
            systemCacheable: true,
            maxTokens: 12000,
          });
        } catch (err) {
          console.warn(
            `[product-defects] deep-dive for ${group.key} failed:`,
            err instanceof Error ? err.message : err,
          );
          raw = {};
        }
        return applyGroupDeepDive(group, raw);
      },
      (done, total) => opts.onProgress?.({ phase: "deep-dive", done, total }),
    );
  }

  // --- Phase 4: prevention strategies --------------------------------------
  opts.onProgress?.({ phase: "strategies", done: 0, total: 1 });
  const strategyPayload = {
    totalDefects: signals.length,
    groups: groups.map((g) => ({
      key: g.key,
      name: g.name,
      description: g.description,
      ticketCount: g.ticketCount,
      sharePct: g.share,
      severityAvg: g.severityAvg,
      preventabilityAvg: g.preventabilityAvg,
      regressionCount: g.regressionCount,
      detectionStages: g.detectionStages,
      triggers: g.triggers,
      topAreas: g.topAreas,
      escapeAnalysis: g.escapeAnalysis.slice(0, 1500),
      subGroups: g.subGroups.map((sg) => ({ key: sg.key, name: sg.name, ticketCount: sg.ticketCount })),
    })),
    codeownersTeams: (correlation?.byTeam ?? []).slice(0, 20).map((t) => ({
      team: t.team,
      defectCount: t.defectCount,
      fileCount: t.fileCount,
      testChangeRate: t.testChangeRate,
    })),
    // Live paths first, stale ones demoted but still shown as evidence.
    hotCodeAreas: promptHotspots(correlation?.areaHotspots ?? [], 15).map((h) => ({
      ...h,
      teams: correlation?.areaHotspots.find((a) => a.path === h.path)?.teams ?? [],
    })),
    fixesWithTests: correlation?.fixesWithTests ?? null,
    fixesWithoutTests: correlation?.fixesWithoutTests ?? null,
    existingMetrics: computedMetrics.map((m) => ({
      key: m.key,
      name: m.name,
      unit: m.unit,
      direction: m.direction,
      current: m.current,
      baseline: m.baseline,
    })),
    disciplines: PREVENTION_DISCIPLINES,
  };
  let strategyRaw: unknown = {};
  try {
    strategyRaw = await complete<unknown>({
      model,
      system: STRATEGY_SYSTEM,
      user: `Today is ${today()}. Propose the prevention programme.\n\n${JSON.stringify(
        strategyPayload,
      )}`,
      systemCacheable: true,
      maxTokens: 20000,
    });
  } catch (err) {
    console.warn(
      "[product-defects] strategy phase failed:",
      err instanceof Error ? err.message : err,
    );
    strategyRaw = {};
  }
  const { strategies, proposedMetrics } = normalizeStrategyPhase(
    strategyRaw,
    groups,
    computedMetrics,
  );
  // Deterministic metrics win; model proposals are appended, never automated.
  const metrics: DefectMetric[] = [...computedMetrics, ...proposedMetrics];
  opts.onProgress?.({ phase: "strategies", done: 1, total: 1 });

  // --- Phase 5: per-team action plans --------------------------------------
  opts.onProgress?.({ phase: "teams", done: 0, total: 1 });
  const ownership = correlation ? teamOwnershipFromCorrelation(correlation) : [];
  const teamPayload = {
    teams: (ownership.length > 0
      ? ownership
      : // No correlation: let the model attribute teams itself from the group
        // profile. Its keys are still filtered to the real population later.
        []
    ).map((own) => {
      const stats = correlation?.byTeam.find((t) => t.team === own.team);
      const keySet = new Set(own.issueKeys);
      return {
        team: own.team,
        defectCount: own.issueKeys.length,
        testChangeRate: stats?.testChangeRate ?? null,
        commitCount: stats?.commitCount ?? null,
        topGroups: groups
          .map((g) => ({
            key: g.key,
            name: g.name,
            ticketCount: g.issueKeys.filter((k) => keySet.has(k)).length,
          }))
          .filter((x) => x.ticketCount > 0)
          .sort((a, b) => b.ticketCount - a.ticketCount)
          .slice(0, 5),
        samples: own.issueKeys
          .slice(0, 12)
          .map((k) => signalByKey.get(k))
          .filter((s): s is DefectSignal => Boolean(s))
          .map((s) => ({
            key: s.issueKey,
            area: s.area,
            failureMode: s.failureMode,
            escapeReason: s.escapeReason,
            detectionStage: s.detectionStage,
            trigger: s.trigger,
          })),
      };
    }),
    /** Present only when we have no CODEOWNERS data and the model must attribute. */
    attributeTeamsYourself: ownership.length === 0,
    groups: groups.map((g) => ({
      key: g.key,
      name: g.name,
      ticketCount: g.ticketCount,
      topAreas: g.topAreas,
      sampleKeys: g.issueKeys.slice(0, 10),
    })),
    strategies: strategies.map((s) => ({
      key: s.key,
      title: s.title,
      discipline: s.discipline,
      team: s.team,
      groupKeys: s.groupKeys,
    })),
    metricKeys: metrics.map((m) => m.key),
  };
  let teamsRaw: unknown = [];
  try {
    teamsRaw = await complete<unknown>({
      model,
      system: TEAMS_SYSTEM,
      user: `Today is ${today()}. Write the per-team action plans.${
        ownership.length === 0
          ? " No CODEOWNERS correlation was available — attribute each group to the engineering team that most plausibly owns it, and list the issueKeys (from the supplied sampleKeys only) you are attributing."
          : ""
      }\n\n${JSON.stringify(teamPayload)}`,
      systemCacheable: true,
      maxTokens: 16000,
    });
  } catch (err) {
    console.warn(
      "[product-defects] teams phase failed:",
      err instanceof Error ? err.message : err,
    );
    teamsRaw = [];
  }
  const teamPlans = normalizeTeamPlans(
    teamsRaw,
    ownership,
    groups,
    signals,
    strategies,
    metrics,
    correlation,
  );
  opts.onProgress?.({ phase: "teams", done: 1, total: 1 });

  // --- Phase 6: per-component narrative -------------------------------------
  // The slices are deterministic and belong to the caller (they need the JIRA
  // component tags, which live on the issues), but they can only be built once
  // the taxonomy exists — so, exactly like `correlationForGroups`, we resolve
  // them mid-run and tolerate a callback that throws.
  let components: ComponentAnalysis[] = [];
  if (opts.componentSlices) {
    let slices: ComponentAnalysis[] = [];
    try {
      const resolved = opts.componentSlices(signals, groups);
      slices = Array.isArray(resolved)
        ? resolved.filter((s): s is ComponentAnalysis => Boolean(s) && typeof s?.slug === "string")
        : [];
    } catch (err) {
      console.warn(
        "[product-defects] component slicing failed:",
        err instanceof Error ? err.message : err,
      );
      slices = [];
    }
    if (slices.length > 0) {
      // Progress counts COMPONENTS, not batches: the UI shows "3/9" and the
      // reader knows exactly which of the nine drilldown pages are written.
      opts.onProgress?.({ phase: "components", done: 0, total: slices.length });
      const reportMetricKeys = metrics.map((m) => m.key);
      const globalStrategyKeys = strategies.map((s) => s.key);
      components = await runPool(
        slices,
        // Same ceiling as the deep dives: these are long generations and the
        // component phase runs 9 of them.
        Math.min(3, parallel),
        async (slice) => {
          const payload = componentPromptPayload(slice, signalByKey, {
            metricKeys: reportMetricKeys,
            reportSummary: synth.executiveSummary,
          });
          let raw: unknown = {};
          try {
            raw = await complete<unknown>({
              model,
              system: COMPONENT_SYSTEM,
              user: `Today is ${today()}. Write the drilldown narrative for the "${
                slice.component
              }" component.\n\n${JSON.stringify(payload)}`,
              systemCacheable: true,
              maxTokens: 8000,
            });
          } catch (err) {
            console.warn(
              `[product-defects] component narrative for ${slice.slug} failed:`,
              err instanceof Error ? err.message : err,
            );
            // Degrade to an un-narrated slice rather than dropping it: the page
            // still renders every deterministic section, which is most of it.
            raw = {};
          }
          return applyComponentNarrative(slice, raw, {
            metricKeys: reportMetricKeys,
            reservedStrategyKeys: globalStrategyKeys,
          });
        },
        (done, total) => opts.onProgress?.({ phase: "components", done, total }),
      );
    }
  } else {
    console.warn(
      "[product-defects] no componentSlices callback supplied; skipping the per-component phase",
    );
  }

  return {
    generatedAt: new Date().toISOString(),
    jql,
    totalTickets: issues.length,
    analyzedTickets: signals.length,
    executiveSummary:
      synth.executiveSummary || "_Analysis completed but no executive summary was produced._",
    groups,
    strategies,
    metrics,
    teamPlans,
    codeCorrelation: correlation,
    signals,
    components,
  };
}
