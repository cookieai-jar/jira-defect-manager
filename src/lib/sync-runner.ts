import { searchIssues, searchResolvedRefs } from "@/lib/jira";
import { runAnalysis } from "@/lib/analysis";
import { computeTrend } from "@/lib/trend";
import { stripDynamicClauses, extractMatchTokens } from "@/lib/jql";
import type { ResolvedTicketRef } from "@/types/triage";
import {
  saveIssue,
  saveAnalysis,
  saveReport,
  recordSyncStart,
  recordSyncFinish,
  listP0,
  upsertP0,
  listDecisions,
  upsertDecision,
} from "@/lib/db";
import { getConfig } from "@/lib/config";
import { finishSyncState, getSyncState, setSyncState, startSyncState } from "@/lib/sync-state";
import { scopeHasP0, type Scope } from "@/types/triage";

/**
 * Kick off a sync for a scope if one isn't already running. Returns whether a
 * sync was started. Shared by the /api/sync route and the server-side scheduler
 * so both honor the same single-flight guard.
 */
export function triggerSync(scope: Scope): { started: boolean } {
  if (getSyncState(scope).running) return { started: false };
  startSyncState(scope);
  void runSync(scope);
  return { started: true };
}

/**
 * Full pull + analyze + persist for one scope. Assumes the caller has already
 * marked the sync running (via triggerSync / startSyncState). Always clears the
 * running state on completion or error.
 */
export async function runSync(scope: Scope): Promise<void> {
  const config = getConfig();
  const masterJql = config.jqls[scope];
  const p0 = scopeHasP0(scope) ? listP0() : [];
  const runId = recordSyncStart(scope);
  try {
    setSyncState(scope, {
      phase: "jira",
      message: "Querying JIRA…",
      done: 0,
      total: 0,
    });
    const issues = await searchIssues(masterJql, config.maxIssuesPerSync);
    for (const issue of issues) saveIssue(scope, issue);
    setSyncState(scope, {
      issuesPulled: issues.length,
      message: `Pulled ${issues.length} issues`,
    });

    // Recently-resolved tickets for the scope — one query, NOT per white-glove
    // customer. We bucket them locally to each customer using the literal
    // values from their JQL fragments.
    const p0ResolvedMap = new Map<string, ResolvedTicketRef[]>();
    if (scopeHasP0(scope) && p0.length > 0) {
      try {
        setSyncState(scope, {
          phase: "jira",
          message: "Pulling recently-resolved tickets for the scope",
        });
        const resolvedBase =
          stripDynamicClauses(masterJql) ||
          masterJql.replace(/\s+ORDER\s+BY\s+.*$/i, "").trim();
        const resolvedJql = `(${resolvedBase}) AND statusCategory = Done AND resolutiondate >= -90d ORDER BY resolutiondate DESC`;
        const allResolved = await searchResolvedRefs(resolvedJql, 1000);
        // Bucket resolved tickets to white-glove customers via literal token
        // matching in summary. Tokens come from the customer's JQL fragment
        // (e.g. for `"Customer[X]" in ("JPMorgan Chase (JPMC)")`, the token
        // "JPMorgan Chase (JPMC)" is matched against ticket summaries).
        for (const customer of p0) {
          const tokens = [
            customer.name,
            ...extractMatchTokens(customer.jqlFragment),
          ].map((t) => t.toLowerCase());
          const matched = allResolved.filter((t) => {
            const hay = t.summary.toLowerCase();
            return tokens.some((tok) => tok.length > 1 && hay.includes(tok));
          });
          p0ResolvedMap.set(customer.name, matched);
        }
      } catch (err) {
        console.warn(
          `[sync] resolved-tickets fetch failed:`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    if (issues.length === 0) {
      saveReport(scope, {
        generatedAt: new Date().toISOString(),
        p0Summaries: [],
        ticketAnalyses: [],
        closeCandidates: [],
        pingCandidates: [],
      });
      recordSyncFinish(runId, "success", 0, 0);
      finishSyncState(scope);
      return;
    }

    const report = await runAnalysis(
      issues,
      p0,
      config,
      scope,
      (event) => {
        setSyncState(scope, {
          phase: event.phase as never,
          done: event.done,
          total: event.total,
          message:
            event.phase === "tickets"
              ? `Analyzing ticket batches (${event.done}/${event.total})`
              : `Summarizing white-glove customers (${event.done}/${event.total})`,
        });
      },
      p0ResolvedMap,
    );

    for (const a of report.ticketAnalyses) saveAnalysis(scope, a);

    // Re-evaluate any previously-ignored priority decisions against the fresh
    // analysis. If the recommendation has changed or the ticket has been
    // updated since the decision (and there's still a non-keep change), flag
    // it for revisit.
    if (scope === "eac") {
      try {
        const decisions = listDecisions();
        const analysisByKey = new Map(report.ticketAnalyses.map((a) => [a.issueKey, a]));
        const issueByKey = new Map(issues.map((i) => [i.key, i]));
        for (const d of decisions) {
          const a = analysisByKey.get(d.issueKey);
          const i = issueByKey.get(d.issueKey);
          if (!a || !i) continue;
          const reasons: string[] = [];
          if (
            d.decidedRecommendedPriority &&
            a.recommendedPriority &&
            d.decidedRecommendedPriority !== a.recommendedPriority
          ) {
            reasons.push(
              `Recommendation changed from ${d.decidedRecommendedPriority} → ${a.recommendedPriority}`,
            );
          }
          if (
            d.decidedCurrentPriority &&
            a.currentPriority &&
            d.decidedCurrentPriority !== a.currentPriority
          ) {
            reasons.push(
              `Current priority changed from ${d.decidedCurrentPriority} → ${a.currentPriority}`,
            );
          }
          if (
            d.decidedTicketUpdatedAt &&
            i.updated > d.decidedTicketUpdatedAt &&
            a.priorityChange &&
            a.priorityChange !== "keep"
          ) {
            reasons.push(
              `Ticket updated on ${i.updated.slice(0, 10)} since decision; recommendation is still "${a.priorityChange}"`,
            );
          }
          const shouldFlag = reasons.length > 0;
          if (shouldFlag !== d.revisitFlagged || (shouldFlag && reasons.join("; ") !== d.revisitReason)) {
            upsertDecision({
              ...d,
              revisitFlagged: shouldFlag,
              revisitReason: shouldFlag ? reasons.join("; ") : null,
            });
          }
        }
      } catch (err) {
        console.warn(
          `[sync] revisit evaluation failed:`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    // Trend chart: extra JIRA query to capture created + resolved counts over
    // the past 30 days. Best-effort — failure shouldn't kill the sync.
    try {
      setSyncState(scope, { message: "Building trend chart", done: 0, total: 1 });
      report.trend = await computeTrend(masterJql, 30);
    } catch (err) {
      console.warn(
        `[sync] trend computation failed:`,
        err instanceof Error ? err.message : err,
      );
    }

    saveReport(scope, report);

    const now = new Date().toISOString();
    for (const customer of p0) {
      upsertP0({ ...customer, lastAnalyzedAt: now });
    }

    recordSyncFinish(runId, "success", issues.length, report.ticketAnalyses.length);
    setSyncState(scope, {
      issuesAnalyzed: report.ticketAnalyses.length,
      message: `Analyzed ${report.ticketAnalyses.length} tickets`,
    });
    finishSyncState(scope);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    recordSyncFinish(runId, "error", 0, 0, msg);
    finishSyncState(scope, msg);
  }
}
