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
import { isScope, scopeHasP0, type Scope } from "@/types/triage";

function scopeFromReq(req: Request): Scope | null {
  const url = new URL(req.url);
  const s = url.searchParams.get("scope");
  return isScope(s) ? s : null;
}

export async function GET(req: Request) {
  const scope = scopeFromReq(req);
  if (!scope)
    return NextResponse.json({ error: "scope must be 'eac' or 'fr'" }, { status: 400 });
  return NextResponse.json(getSyncState(scope));
}

export async function POST(req: Request) {
  const scope = scopeFromReq(req);
  if (!scope)
    return NextResponse.json({ error: "scope must be 'eac' or 'fr'" }, { status: 400 });
  if (getSyncState(scope).running) {
    return NextResponse.json({ error: "sync already running" }, { status: 409 });
  }
  startSyncState(scope);
  void runSync(scope);
  return NextResponse.json({ ok: true, state: getSyncState(scope) }, { status: 202 });
}

async function runSync(scope: Scope) {
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

    // For each P0 customer, pull the authoritative set of tickets via
    // (masterJql) AND (jqlFragment). This is the user's source of truth for
    // which tickets belong to which P0 — overriding any model inference.
    const issueMap = new Map(issues.map((i) => [i.key, i]));
    const p0TicketMap = new Map<string, string>();
    const masterCore = masterJql.replace(/\s+ORDER\s+BY\s+.*$/i, "").trim();
    for (let i = 0; i < p0.length; i++) {
      const customer = p0[i];
      setSyncState(scope, {
        phase: "jira",
        message: `Matching P0 customer ${i + 1}/${p0.length}: ${customer.name}`,
        done: i,
        total: p0.length,
      });
      try {
        const jql = `(${masterCore}) AND (${customer.jqlFragment})`;
        const matched = await searchIssues(jql, 500);
        for (const m of matched) {
          if (!issueMap.has(m.key)) {
            issueMap.set(m.key, m);
            saveIssue(scope, m);
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
    setSyncState(scope, {
      issuesPulled: enrichedIssues.length,
      message: `Pulled ${enrichedIssues.length} issues (${p0TicketMap.size} mapped to P0 customers)`,
    });

    if (enrichedIssues.length === 0) {
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
      enrichedIssues,
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
              : `Summarizing P0 customers (${event.done}/${event.total})`,
        });
      },
      p0TicketMap,
    );

    for (const a of report.ticketAnalyses) saveAnalysis(scope, a);
    saveReport(scope, report);

    const now = new Date().toISOString();
    for (const customer of p0) {
      upsertP0({ ...customer, lastAnalyzedAt: now });
    }

    recordSyncFinish(runId, "success", enrichedIssues.length, report.ticketAnalyses.length);
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
