import { NextResponse } from "next/server";
import { searchIssues } from "@/lib/jira";
import { runAnalysis } from "@/lib/analysis";
import {
  saveIssue,
  saveAnalysis,
  saveReport,
  recordSyncStart,
  recordSyncFinish,
  listP0,
  upsertP0,
} from "@/lib/db";
import { getConfig } from "@/lib/config";
import {
  finishSyncState,
  getSyncState,
  setSyncState,
  startSyncState,
} from "@/lib/sync-state";

export async function GET() {
  return NextResponse.json(getSyncState());
}

export async function POST() {
  if (getSyncState().running) {
    return NextResponse.json({ error: "sync already running" }, { status: 409 });
  }
  startSyncState();
  void runSync();
  return NextResponse.json({ ok: true, state: getSyncState() }, { status: 202 });
}

async function runSync() {
  const config = getConfig();
  const p0 = listP0();
  const runId = recordSyncStart();
  try {
    setSyncState({ phase: "jira", message: "Querying JIRA…", done: 0, total: 0 });
    const issues = await searchIssues(config.masterJql, config.maxIssuesPerSync);
    for (const issue of issues) saveIssue(issue);
    setSyncState({ issuesPulled: issues.length, message: `Pulled ${issues.length} issues` });

    // For each P0 customer, pull the authoritative set of tickets via
    // (masterJql) AND (jqlFragment). This is the user's source of truth for
    // which tickets belong to which P0 — overriding any model inference.
    const issueMap = new Map(issues.map((i) => [i.key, i]));
    const p0TicketMap = new Map<string, string>();
    const masterCore = config.masterJql.replace(/\s+ORDER\s+BY\s+.*$/i, "").trim();
    for (let i = 0; i < p0.length; i++) {
      const customer = p0[i];
      setSyncState({
        phase: "jira",
        message: `Matching P0 customer ${i + 1}/${p0.length}: ${customer.name}`,
        done: i,
        total: p0.length,
      });
      try {
        const jql = `(${masterCore}) AND (${customer.jqlFragment})`;
        const matched = await searchIssues(jql, 500);
        for (const m of matched) {
          // Ensure the issue is in the cache too (it may not have come back in the master pull
          // if the master JQL caps at maxIssuesPerSync).
          if (!issueMap.has(m.key)) {
            issueMap.set(m.key, m);
            saveIssue(m);
          }
          p0TicketMap.set(m.key, customer.name);
        }
      } catch (err) {
        console.warn(
          `P0 customer "${customer.name}" JQL fragment failed:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
    const enrichedIssues = Array.from(issueMap.values());
    setSyncState({
      issuesPulled: enrichedIssues.length,
      message: `Pulled ${enrichedIssues.length} issues (${p0TicketMap.size} mapped to P0 customers)`,
    });

    if (enrichedIssues.length === 0) {
      saveReport({
        generatedAt: new Date().toISOString(),
        p0Summaries: [],
        ticketAnalyses: [],
        twoSprintPlan: "_No tickets matched the master JQL._",
        closeCandidates: [],
        pingCandidates: [],
      });
      recordSyncFinish(runId, "success", 0, 0);
      finishSyncState();
      return;
    }

    const report = await runAnalysis(
      enrichedIssues,
      p0,
      config,
      (event) => {
        setSyncState({
          phase: event.phase as never,
          done: event.done,
          total: event.total,
          message:
            event.phase === "tickets"
              ? `Analyzing ticket batches (${event.done}/${event.total})`
              : event.phase === "p0"
                ? `Summarizing P0 customers (${event.done}/${event.total})`
                : "Building 2-sprint plan",
        });
      },
      p0TicketMap,
    );

    for (const a of report.ticketAnalyses) saveAnalysis(a);
    saveReport(report);

    // Bump lastAnalyzedAt on every P0 we summarized.
    const now = new Date().toISOString();
    for (const customer of p0) {
      upsertP0({ ...customer, lastAnalyzedAt: now });
    }

    recordSyncFinish(runId, "success", enrichedIssues.length, report.ticketAnalyses.length);
    setSyncState({
      issuesAnalyzed: report.ticketAnalyses.length,
      message: `Analyzed ${report.ticketAnalyses.length} tickets`,
    });
    finishSyncState();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    recordSyncFinish(runId, "error", 0, 0, msg);
    finishSyncState(msg);
  }
}
