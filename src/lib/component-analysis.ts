/**
 * Per-JIRA-component slicing of the Product Defect Analysis report — the pure,
 * deterministic half.
 *
 * The parent report answers "what kinds of defects do customers find across the
 * whole product?". A component page answers the same question for the slice of
 * the population an owning team can actually act on: "what fails in Lifecycle
 * Management, and which gate keeps missing it?".
 *
 * Everything here is a pure function over plain data: no db, no network, no
 * model calls, no filesystem. `summary`, `escapeAnalysis` and `strategies` are
 * left empty for the model phase to fill in; every count, share, average,
 * distribution, metric series and code correlation is computed here so a model
 * that miscounts cannot corrupt what the dashboard reports.
 *
 * TWO THINGS ABOUT COMPONENTS THAT LOOK LIKE BUGS AND ARE NOT:
 *
 * 1. Components are TAGS, NOT A PARTITION. A defect carrying both "Integrations"
 *    and "Graph" is counted in full under both, because it is genuinely a defect
 *    both teams need to see. Consequently `sum(defectCount)` over the returned
 *    analyses EXCEEDS the population, and `sum(share)` exceeds 100. Splitting a
 *    defect fractionally across its components would make every per-component
 *    number unusable for the team reading it, so we do not. A defect with NO
 *    component belongs to no slice at all (it still counts in the parent report).
 *
 * 2. THERE ARE TWO DIFFERENT `share` FIELDS, with different denominators:
 *      - `ComponentAnalysis.share`      — % of the WHOLE analyzed population
 *                                         ("Integrations is 42% of all defects")
 *      - `ComponentGroupSlice.share`    — % of THIS COMPONENT's defects
 *                                         ("pagination is 18% of Integrations")
 *    Both render in the UI, side by side. The first sums to >100 across
 *    components; the second sums to <=100 within one component (short of 100
 *    only by the component's defects that the taxonomy never classified).
 *
 * Component names are matched EXACTLY on the JIRA string. Case and whitespace
 * are deliberately not normalised: if JIRA carries two spellings of one team's
 * component, those are two components here, and that divergence is itself worth
 * seeing on the dashboard rather than being quietly merged away.
 */

import type { JiraIssue } from "@/types/triage";
import type {
  CodeCorrelation,
  ComponentAnalysis,
  ComponentGroupSlice,
  DefectGroup,
  DefectSignal,
  DefectTrigger,
  DetectionStage,
} from "@/types/product-defects";
import { DEFECT_TRIGGERS, DETECTION_STAGES } from "@/types/product-defects";
import { buildCorrelation, correlationByGroup } from "./code-correlation";
import { computeDefectMetrics } from "./defect-metrics";
// `pct` and `slugify` are imported rather than re-implemented on purpose: a
// component slice must never disagree with the parent report about how a share
// is rounded or how a key is slugged.
import { pct, slugify } from "./product-defects-analysis";

/** Minimum defects for a component to get its own analysis. Mirrors `pdaComponentMinDefects`. */
export const DEFAULT_COMPONENT_MIN_DEFECTS = 25;

/** Ranked-list length for a component's own hotspots — same as the parent report's default. */
const HOTSPOT_TOP_N = 25;
/** Ranked-list length for the per-group hotspots inside one component's card. */
const GROUP_HOTSPOT_TOP_N = 10;
/** How many top areas / failure modes a component carries, as the parent groups do. */
const TOP_LABEL_COUNT = 6;

// ---------------------------------------------------------------------------
// Local copies of the parent report's unexported arithmetic helpers
// ---------------------------------------------------------------------------

/** Round to one decimal — averages are displayed, not used for further math. */
function round1(n: number): number {
  return Math.round(n * 10) / 10;
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

/** Top-N values by frequency, most frequent first, ties by label. */
function topByFrequency(values: string[], n: number): string[] {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n)
    .map(([v]) => v);
}

/**
 * Count a union-typed field, descending by count with the canonical union order
 * as the tie-break. The union order — not alphabetical order — is what keeps two
 * runs over the same data from emitting differently ordered distributions.
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

function stageCounts(sigs: DefectSignal[]): Array<{ stage: DetectionStage; count: number }> {
  return countBy(
    sigs.map((s) => s.detectionStage),
    DETECTION_STAGES,
  ).map(({ value, count }) => ({ stage: value, count }));
}

function triggerCounts(sigs: DefectSignal[]): Array<{ trigger: DefectTrigger; count: number }> {
  return countBy(
    sigs.map((s) => s.trigger),
    DEFECT_TRIGGERS,
  ).map(({ value, count }) => ({ trigger: value, count }));
}

/** Mean of a scored field over signals; 0 — never NaN — for an empty set. */
function avgOf(sigs: DefectSignal[], pick: (s: DefectSignal) => number): number {
  if (sigs.length === 0) return 0;
  return round1(sigs.reduce((n, s) => n + pick(s), 0) / sigs.length);
}

// ---------------------------------------------------------------------------
// Component enumeration
// ---------------------------------------------------------------------------

/**
 * The distinct components tagged on one issue, in JIRA's order. Blank entries
 * are dropped (they are data noise, not a component), and a component repeated
 * on the same ticket is counted once — otherwise a duplicated tag would inflate
 * that component's defect count.
 */
function componentsOf(issue: JiraIssue): string[] {
  return uniq((issue.components ?? []).filter((c) => c.trim().length > 0));
}

/**
 * Component name -> defect count over the whole population, descending.
 * Ties are broken by name so the ordering is reproducible run to run.
 */
export function componentCounts(issues: JiraIssue[]): Array<{ component: string; count: number }> {
  const counts = new Map<string, number>();
  for (const issue of issues) {
    for (const component of componentsOf(issue)) {
      counts.set(component, (counts.get(component) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([component, count]) => ({ component, count }))
    .sort((a, b) => b.count - a.count || a.component.localeCompare(b.component));
}

/**
 * Components clearing `minDefects`, descending by count. The threshold is
 * inclusive: a component with exactly `minDefects` defects qualifies. Below it
 * there is not enough evidence for a pattern and a narrative reads as
 * speculation — but those defects still count everywhere in the parent report.
 */
export function qualifyingComponents(issues: JiraIssue[], minDefects?: number): string[] {
  const min = Math.max(1, Math.floor(minDefects ?? DEFAULT_COMPONENT_MIN_DEFECTS));
  return componentCounts(issues)
    .filter((c) => c.count >= min)
    .map((c) => c.component);
}

/** URL slug for a component name, e.g. "Lifecycle Management" -> "lifecycle-management". */
export function componentSlug(component: string): string {
  return slugify(component);
}

// ---------------------------------------------------------------------------
// Code correlation, restricted to a subset of tickets
// ---------------------------------------------------------------------------

/**
 * Recover a per-path "does this still exist at HEAD?" answer from a parent
 * correlation's already-stamped hotspots.
 *
 * The git layer is long gone by the time components are sliced, so without this
 * a component's hotspots would lose `existsAtHead` and the UI could not tell a
 * live ownership gap from a path that has since been deleted. Paths outside the
 * parent's ranked lists answer `undefined` — unknown, deliberately not absent.
 */
function existenceFromParent(
  correlation: CodeCorrelation,
): ((path: string) => boolean | undefined) | undefined {
  const known = new Map<string, boolean>();
  for (const list of [correlation.fileHotspots, correlation.areaHotspots]) {
    for (const h of list ?? []) {
      if (h.existsAtHead !== undefined) known.set(h.path, h.existsAtHead);
    }
  }
  if (known.size === 0) return undefined;
  return (path: string) => known.get(path);
}

/**
 * Restrict a correlation to a subset of tickets by REBUILDING it, never by
 * copying the parent's aggregates. `buildCorrelation` already filters the links
 * to the supplied population, so hotspots, `byTeam`, `linkedTickets`,
 * `fixesWithTests`/`fixesWithoutTests` and `linkRate` are all recomputed over
 * the subset — and `linkRate` becomes a percentage of THIS component's defects,
 * which is the only reading that makes sense on a component page.
 *
 * Supply `owners` whenever it is available. A stored correlation cannot carry
 * the CODEOWNERS resolver, and without one `buildCorrelation` degrades to its
 * documented fallback — the ticket-level team union — which credits EVERY team
 * named anywhere on a ticket with ALL of that ticket's files. Measured on this
 * repo, that inflated one broad owner from 77 touched files to 793. A component
 * page would then contradict the parent report's team cards for a reason that
 * has nothing to do with the ticket subset, and both numbers would look equally
 * authoritative. The fallback is still honest about WHICH tickets a team is
 * involved in, so it is a usable degradation — just not a silent one.
 */
function restrictCorrelation(
  parent: CodeCorrelation,
  issueKeys: string[],
  slices: ComponentGroupSlice[],
  owners?: (path: string) => string[],
  existsAtHead?: (path: string) => boolean | undefined,
): CodeCorrelation {
  const restricted = buildCorrelation({
    repoPath: parent.repoPath,
    repoHead: parent.repoHead,
    allIssueKeys: issueKeys,
    links: parent.links ?? [],
    topN: HOTSPOT_TOP_N,
    owners,
    existsAtHead: existsAtHead ?? existenceFromParent(parent),
  });
  // Where each group lives in the code *within this component* — a different
  // question from the parent's report-wide `byGroup`, and the one a component
  // owner asks. Uses the same helper the parent runner does.
  restricted.byGroup = correlationByGroup(
    restricted,
    slices.map((s) => ({ key: s.groupKey, issueKeys: s.issueKeys })),
    GROUP_HOTSPOT_TOP_N,
    owners,
  );
  return restricted;
}

// ---------------------------------------------------------------------------
// The slice builder
// ---------------------------------------------------------------------------

export interface ComponentSliceInput {
  issues: JiraIssue[];
  signals: DefectSignal[];
  groups: DefectGroup[];
  correlation?: CodeCorrelation | null;
  /**
   * Per-file CODEOWNERS resolver, shaped exactly like `ownerLookup(rules)` from
   * `@/lib/code-correlation`. Without it, subset team attribution silently falls
   * back to the coarser ticket-level union, which inflates broad owners — see
   * `restrictCorrelation`.
   */
  owners?: (path: string) => string[];
  /**
   * Authoritative "does this path exist at HEAD?" predicate. Strongly preferred
   * over the parent-hotspot fallback: a component ranks its OWN top-N hotspots,
   * so most of them never appear in the parent's ranked lists and would answer
   * `undefined` — which downstream reads as "assume it exists" and lets a
   * deleted path become a remediation target.
   */
  existsAtHead?: (path: string) => boolean | undefined;
  /** Minimum defects for a component to qualify for its own analysis. */
  minDefects?: number;
  /** Injected for deterministic metric tests. */
  now?: Date;
}

/**
 * Build the deterministic part of every qualifying component's analysis:
 * everything except `summary`, `escapeAnalysis` and `strategies`, which the
 * model fills in later. Those three are present as empty string / empty array,
 * so each object is already a valid `ComponentAnalysis` on its own — the
 * dashboard renders correctly (minus narrative) even if the model phase fails.
 *
 * Returned descending by defect count, ties by component name.
 */
export function buildComponentAnalyses(input: ComponentSliceInput): ComponentAnalysis[] {
  const issues = input.issues ?? [];
  const signals = input.signals ?? [];
  const groups = input.groups ?? [];
  const parentCorrelation = input.correlation ?? null;

  // Denominator for `ComponentAnalysis.share`: the analyzed population we are
  // slicing. Taken from `issues` (not `signals`) so `defectCount / population`
  // is internally consistent — a ticket the extraction phase somehow produced no
  // signal for is still one of this component's defects.
  const population = issues.length;

  const names = qualifyingComponents(issues, input.minDefects);
  const signalByKey = new Map(signals.map((s) => [s.issueKey, s]));

  // Slug collisions are possible in principle — exact-match component names can
  // differ only in punctuation ("Access AI" vs "Access-AI") and still slug the
  // same. Suffix duplicates so every component page stays addressable by slug.
  const usedSlugs = new Set<string>();

  return names.map((component) => {
    const componentIssues = issues.filter((i) => componentsOf(i).includes(component));
    const issueKeys = componentIssues.map((i) => i.key);
    const keySet = new Set(issueKeys);
    const componentSignals = issueKeys
      .map((k) => signalByKey.get(k))
      .filter((s): s is DefectSignal => s !== undefined);

    const defectCount = componentIssues.length;

    // Group slices: intersect each parent group with this component. A group
    // with no defects here is OMITTED rather than rendered as a zero row — a
    // component page listing fourteen groups, eleven of them empty, buries the
    // three that matter.
    const slices: ComponentGroupSlice[] = groups
      .map((group) => {
        const sliceKeys = group.issueKeys.filter((k) => keySet.has(k));
        const sliceSignals = sliceKeys
          .map((k) => signalByKey.get(k))
          .filter((s): s is DefectSignal => s !== undefined);
        return {
          groupKey: group.key,
          name: group.name,
          ticketCount: sliceKeys.length,
          // Denominator is THIS COMPONENT, not the population — see the file header.
          share: pct(sliceKeys.length, defectCount),
          issueKeys: sliceKeys,
          detectionStages: stageCounts(sliceSignals),
          triggers: triggerCounts(sliceSignals),
        };
      })
      .filter((s) => s.ticketCount > 0)
      .sort((a, b) => b.ticketCount - a.ticketCount || a.name.localeCompare(b.name));

    const codeCorrelation = parentCorrelation
      ? restrictCorrelation(parentCorrelation, issueKeys, slices, input.owners, input.existsAtHead)
      : null;

    let slug = componentSlug(component);
    if (usedSlugs.has(slug)) {
      for (let i = 2; usedSlugs.has(slug); i++) slug = `${componentSlug(component)}-${i}`;
    }
    usedSlugs.add(slug);

    return {
      component,
      slug,
      defectCount,
      // % of the whole population; sums to >100 across components by design.
      share: pct(defectCount, population),
      issueKeys,
      severityAvg: avgOf(componentSignals, (s) => s.severityScore),
      preventabilityAvg: avgOf(componentSignals, (s) => s.preventability),
      regressionCount: componentSignals.filter((s) => s.isRegression).length,
      detectionStages: stageCounts(componentSignals),
      triggers: triggerCounts(componentSignals),
      topAreas: topByFrequency(
        componentSignals.map((s) => s.area).filter((x): x is string => Boolean(x)),
        TOP_LABEL_COUNT,
      ),
      topFailureModes: topByFrequency(
        componentSignals.map((s) => s.failureMode).filter(Boolean),
        TOP_LABEL_COUNT,
      ),
      groups: slices,
      // Left for the model phase; empty here so the object is already valid.
      summary: "",
      escapeAnalysis: "",
      strategies: [],
      // Recomputed over this component's issues, with its own signals, group
      // slices and correlation, so the escape-stage, concentration, fix-with-test
      // and hotspot metrics are genuinely component-specific rather than the
      // report-wide series repeated on every page.
      metrics: computeDefectMetrics(componentIssues, {
        now: input.now,
        signals: componentSignals,
        groups: slices.map((s) => ({
          key: s.groupKey,
          name: s.name,
          issueKeys: s.issueKeys,
        })),
        correlation: codeCorrelation,
      }),
      codeCorrelation,
      // Denormalized from the restricted correlation (already sorted by defect
      // count) so a component's team list reads without re-deriving it.
      teams: codeCorrelation ? [...codeCorrelation.byTeam] : [],
    };
  });
}
