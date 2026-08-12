import { searchAllIssues } from "@/lib/jira";
import { getConfig } from "@/lib/config";
import {
  replaceProductDefectIssues,
  saveProductDefectReport,
  saveProductDefectSignals,
  listProductDefectSignals,
  recordProductDefectMetricPoints,
  recordSyncStart,
  recordSyncFinish,
} from "@/lib/db";
import {
  analyzeProductDefects,
  emptyProductDefectAnalysis,
} from "@/lib/product-defects-analysis";
import {
  buildCodeCorrelation,
  existsAtHeadFrom,
  pathsAtHead,
  readCodeowners,
} from "@/lib/code-correlation-git";
import { correlationByGroup, ownerLookup } from "@/lib/code-correlation";
import { buildComponentAnalyses } from "@/lib/component-analysis";
import { computeDefectMetrics } from "@/lib/defect-metrics";
import {
  finishProductDefectsSyncState,
  setProductDefectsSyncState,
} from "@/lib/product-defects-sync-state";
import type {
  CodeCorrelation,
  DefectMetric,
  PreventionStrategy,
} from "@/types/product-defects";
import type { Scope } from "@/types/triage";

/**
 * The shared sync_runs table is keyed by a scope column; record Product Defect
 * Analysis runs under this synthetic scope so they don't collide with the
 * triage scopes (or with the Strategic Integrations "si" pseudo-scope).
 */
const PDA_SCOPE = "pda" as unknown as Scope;

/**
 * Merge the deterministic metrics we compute ourselves with any additional
 * not-yet-instrumented metrics the model proposed during the strategy phase.
 * Computed metrics win on key collision — a real series beats a suggestion.
 */
function mergeMetrics(computed: DefectMetric[], proposed: DefectMetric[]): DefectMetric[] {
  const byKey = new Map(computed.map((m) => [m.key, m]));
  for (const p of proposed) {
    if (!byKey.has(p.key)) byKey.set(p.key, { ...p, automated: false });
  }
  return [...byKey.values()];
}


/**
 * Drop code paths that no longer exist at HEAD from every strategy's
 * `codeAreas`, global and per-component.
 *
 * The prompts already tell the model to avoid stale paths, and hotspots carry
 * `existsAtHead` — but that flag is only stamped on ranked hotspots, and each
 * component ranks its OWN top-N, so most component hotspots answer "unknown"
 * and unknown reads as "assume it exists". A single authoritative pass here is
 * the only thing that actually guarantees it: a work item pointing at a deleted
 * directory is worse than no work item, because someone has to go find out.
 */
function pruneDeadCodeAreas(
  strategies: PreventionStrategy[],
  exists: (path: string) => boolean | undefined,
): { strategies: PreventionStrategy[]; dropped: string[] } {
  const dropped: string[] = [];
  const pruned = strategies.map((s) => {
    const areas = (s.codeAreas ?? []).filter((p) => {
      if (exists(p) === false) {
        dropped.push(`${s.key}:${p}`);
        return false;
      }
      return true;
    });
    return areas.length === (s.codeAreas ?? []).length ? s : { ...s, codeAreas: areas };
  });
  return { strategies: pruned, dropped };
}

/**
 * Full Product Defect Analysis run.
 *
 * Ordering is deliberate. The deterministic passes (JIRA pull, git/CODEOWNERS
 * correlation, ticket-history metrics) run FIRST so the expensive model phases
 * can be grounded in real code ownership and real trends rather than inventing
 * them. Metrics are then recomputed after synthesis, because the richest ones
 * (escape-stage mix, regression rate, preventability, group concentration)
 * depend on signals and groups that only exist once the model has run.
 *
 * Assumes the caller has already marked the sync running. Always clears the
 * running state on completion or error.
 */
export async function runProductDefectSync(): Promise<void> {
  const config = getConfig();
  const runId = recordSyncStart(PDA_SCOPE);
  try {
    // 1. Pull the whole population (paged 100 at a time by searchAllIssues).
    setProductDefectsSyncState({
      phase: "jira",
      message: "Querying JIRA (all pages)…",
      done: 0,
      total: 0,
    });
    const issues = await searchAllIssues(config.pdaJql);
    replaceProductDefectIssues(issues);
    setProductDefectsSyncState({
      issuesPulled: issues.length,
      message: `Pulled ${issues.length} customer-found defects`,
    });

    if (issues.length === 0) {
      saveProductDefectReport(emptyProductDefectAnalysis(0, config.pdaJql));
      recordSyncFinish(runId, "success", 0, 0);
      finishProductDefectsSyncState();
      return;
    }

    const issueKeys = issues.map((i) => i.key);

    // 2. Correlate defects to code via git history + CODEOWNERS. Best-effort:
    //    a missing or unreadable repo must not kill the analysis.
    setProductDefectsSyncState({
      phase: "correlate",
      message: `Correlating defects to ${config.codeRepoPath}…`,
      done: 0,
      total: 1,
    });
    let correlation: CodeCorrelation | null = null;
    try {
      correlation = await buildCodeCorrelation(config.codeRepoPath, issueKeys, {
        onProgress: (done, total) =>
          setProductDefectsSyncState({ phase: "correlate", done, total }),
      });
      setProductDefectsSyncState({
        message: `Linked ${correlation.linkedTickets}/${correlation.totalTickets} defects to code (${correlation.linkRate}%)`,
      });
    } catch (err) {
      console.warn(
        "[product-defects] code correlation failed:",
        err instanceof Error ? err.message : err,
      );
    }

    // Per-file CODEOWNERS resolver for the component slices. A stored
    // CodeCorrelation cannot carry a function, and without one the subset
    // rebuild falls back to ticket-level team union — which credits every team
    // named on a ticket with all of that ticket's files and inflates broad
    // owners by an order of magnitude. Best-effort: no resolver just means the
    // coarser fallback, not a failed run.
    let owners: ((path: string) => string[]) | undefined;
    let pathExists: (path: string) => boolean | undefined = () => undefined;
    try {
      owners = ownerLookup(await readCodeowners(config.codeRepoPath));
      pathExists = existsAtHeadFrom(await pathsAtHead(config.codeRepoPath));
    } catch (err) {
      console.warn(
        "[product-defects] CODEOWNERS/HEAD read failed; component team stats fall back to ticket-level attribution and dead-path pruning is skipped:",
        err instanceof Error ? err.message : err,
      );
    }

    // 3. Baseline metrics from ticket history alone — passed into the model so
    //    strategies can cite real numbers and attach to real metric keys.
    setProductDefectsSyncState({ phase: "metrics", message: "Computing defect metrics", done: 0, total: 1 });
    const baseMetrics = computeDefectMetrics(issues, { correlation });
    setProductDefectsSyncState({ phase: "metrics", done: 1, total: 1 });

    // 4. The model phases: extract → synthesize → deep-dive → strategies → teams.
    //
    //    Extraction over the full population is the expensive part (hours of
    //    model time), so it resumes from whatever was checkpointed on a prior
    //    run and checkpoints each batch as it lands. An interruption then costs
    //    one batch, not the whole phase.
    //
    //    A signal is only reusable if the ticket it was taken from has not
    //    changed in JIRA since. Comparing against our own synced_at cannot work
    //    — replaceProductDefectIssues above re-stamps it every run, which would
    //    invalidate the whole cache every time and make the checkpoint
    //    write-only.
    const updatedByKey = new Map(issues.map((i) => [i.key, i.updated]));
    const cachedSignals = listProductDefectSignals()
      .filter((c) => c.issueUpdated != null && updatedByKey.get(c.signal.issueKey) === c.issueUpdated)
      .map((c) => c.signal);
    if (cachedSignals.length > 0) {
      setProductDefectsSyncState({
        message: `Resuming: ${cachedSignals.length} of ${issues.length} signals reused from cache`,
      });
    }
    const report = await analyzeProductDefects(issues, {
      model: config.model,
      jql: config.pdaJql,
      correlation,
      metrics: baseMetrics,
      cachedSignals,
      onSignalsBatch: (batch) => saveProductDefectSignals(batch, updatedByKey),
      // Extraction is I/O-bound on the API and the SDK already retries 429/529
      // with backoff, so the default of 3 leaves the run an order of magnitude
      // slower than it needs to be — 162 batches took over two hours.
      parallel: 8,
      // Group-level code context only exists once synthesis has produced the
      // taxonomy, so the analyzer asks for it mid-run rather than up front.
      correlationForGroups: (groups) =>
        correlation ? correlationByGroup(correlation, groups) : [],
      // Per-component slices are likewise resolved mid-run: they bucket the
      // finished taxonomy by JIRA component, so they cannot exist until the
      // groups do. Everything here is deterministic — the analyzer only adds
      // the narrative and the component-scoped strategies.
      componentSlices: (signals, groups) =>
        buildComponentAnalyses({
          issues,
          signals,
          groups,
          correlation,
          minDefects: config.pdaComponentMinDefects,
          owners,
          existsAtHead: pathExists,
        }),
      onProgress: (event) => {
        const label: Record<typeof event.phase, string> = {
          extract: `Extracting defect signals (${event.done}/${event.total})`,
          synthesize: "Synthesizing defect groups & sub-groups",
          "deep-dive": `Deep-diving each group (${event.done}/${event.total})`,
          strategies: "Deriving prevention strategies",
          teams: "Building per-team action plans",
          components: `Analyzing each JIRA component (${event.done}/${event.total})`,
        };
        setProductDefectsSyncState({
          phase: event.phase,
          done: event.done,
          total: event.total,
          message: label[event.phase],
        });
      },
    });

    // 5. Recompute metrics now that signals and groups exist, and fold the
    //    per-group code correlation into the stored report.
    //
    //    Only the model's NEW proposals are carried over from the report. The
    //    rest of report.metrics is just baseMetrics echoed back, and that pass
    //    was computed without signals — so it contains placeholders (e.g. the
    //    single "escape-stage-mix" stand-in) that the signal-aware pass has
    //    since replaced with real per-stage metrics. Merging those back in
    //    would resurrect a placeholder alongside the thing that superseded it.
    const baseKeys = new Set(baseMetrics.map((m) => m.key));
    const proposedMetrics = report.metrics.filter((m) => !baseKeys.has(m.key));
    const finalMetrics = mergeMetrics(
      computeDefectMetrics(issues, {
        correlation,
        signals: report.signals,
        groups: report.groups.map((g) => ({
          key: g.key,
          name: g.name,
          issueKeys: g.issueKeys,
        })),
      }),
      proposedMetrics,
    );

    const finalCorrelation: CodeCorrelation | null = correlation
      ? { ...correlation, byGroup: correlationByGroup(correlation, report.groups) }
      : null;

    // Last gate before anything reaches a team: no action item may point at a
    // path that no longer exists. Applied to global AND component strategies.
    const globalPruned = pruneDeadCodeAreas(report.strategies, pathExists);
    const componentsPruned = report.components.map((c) => {
      const p = pruneDeadCodeAreas(c.strategies, pathExists);
      return { pruned: { ...c, strategies: p.strategies }, dropped: p.dropped };
    });
    const allDropped = [
      ...globalPruned.dropped,
      ...componentsPruned.flatMap((c) => c.dropped),
    ];
    if (allDropped.length > 0) {
      console.warn(
        `[product-defects] dropped ${allDropped.length} strategy code path(s) that no longer exist at HEAD: ${allDropped.join(", ")}`,
      );
    }

    saveProductDefectReport({
      ...report,
      strategies: globalPruned.strategies,
      components: componentsPruned.map((c) => c.pruned),
      metrics: finalMetrics,
      codeCorrelation: finalCorrelation,
    });

    // 6. Snapshot today's automated metric values. Ticket-history metrics are
    //    backfilled on every run, but snapshotting means a metric that later
    //    becomes unbackfillable (or whose definition changes) still has history.
    const day = new Date().toISOString().slice(0, 10);
    recordProductDefectMetricPoints(
      day,
      finalMetrics
        .filter((m) => m.automated && m.current != null)
        .map((m) => ({ metric: m.key, value: m.current as number })),
    );

    recordSyncFinish(runId, "success", issues.length, report.analyzedTickets);
    setProductDefectsSyncState({
      issuesAnalyzed: report.analyzedTickets,
      message: `Analyzed ${report.analyzedTickets} defects · ${report.groups.length} groups · ${report.strategies.length} strategies`,
    });
    finishProductDefectsSyncState();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    recordSyncFinish(runId, "error", 0, 0, msg);
    finishProductDefectsSyncState(msg);
  }
}
