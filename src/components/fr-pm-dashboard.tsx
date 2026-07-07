"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Inbox,
  Flame,
  Clock,
  UserX,
  GitBranch,
} from "lucide-react";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusChip } from "@/components/jira-chips";
import { SyncButton } from "@/components/sync-button";
import { P0Card } from "@/components/p0-card";
import { TicketDrawer } from "@/components/ticket-drawer";
import { FrPmTable } from "@/components/fr-pm-table";
import { FrFlowTrend } from "@/components/fr-flow-trend";
import { FrRoadmap } from "@/components/fr-roadmap";
import { FrDemandValueMatrix } from "@/components/fr-demand-value-matrix";
import { FrDecisionsNeeded } from "@/components/fr-decisions-needed";
import { FrSprintPlan } from "@/components/fr-sprint-plan";
import { FrTeamLoad, FrBlocked } from "@/components/fr-team-load";
import { FrDemandInsights } from "@/components/fr-demand-insights";
import { inFlightAging } from "@/lib/fr-delivery";
import { cn } from "@/lib/utils";
import type { JiraIssue, TriageReport } from "@/types/triage";

export function FrPmDashboard() {
  const scope = "fr" as const;
  const [report, setReport] = useState<TriageReport | null>(null);
  const [issues, setIssues] = useState<JiraIssue[]>([]);
  const [jiraBaseUrl, setJiraBaseUrl] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetch(`/api/report?scope=${scope}`).then((r) => r.json());
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

  const rows = useMemo(() => {
    if (!report) return [];
    const map = new Map(issues.map((i) => [i.key, i]));
    return report.ticketAnalyses
      .map((a) => {
        const issue = map.get(a.issueKey);
        return issue ? { ...a, issue } : null;
      })
      .filter((x): x is NonNullable<typeof x> => Boolean(x));
  }, [report, issues]);

  const stats = useMemo(() => {
    const total = rows.length;
    const highDemand = rows.filter((r) => r.temperatureScore >= 7).length;
    // Reframed from "stalled backlog" (noise — idle backlog is normal for FRs)
    // to aging *in-flight* work: active/blocked items that have gone quiet.
    const aging = inFlightAging(rows).length;
    const unassigned = rows.filter(
      (r) => r.status !== "resolved" && !r.issue.assignee,
    ).length;
    const blocked = rows.filter((r) => r.status === "blocked").length;
    return { total, highDemand, aging, unassigned, blocked };
  }, [rows]);

  const statusPipeline = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of rows) {
      if (r.status === "resolved") continue;
      counts.set(r.issue.status, (counts.get(r.issue.status) ?? 0) + 1);
    }
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  }, [rows]);

  const totalForPipeline = statusPipeline.reduce((n, [, c]) => n + c, 0);

  return (
    <div className="flex-1 overflow-auto scroll-thin">
      <header className="px-6 h-14 border-b border-border flex items-center justify-between sticky top-0 z-10 bg-bg/90 backdrop-blur">
        <div className="flex items-center gap-2">
          <div>
            <h1 className="text-lg font-semibold">Feature Requests</h1>
          </div>
        </div>
        <SyncButton scope={scope} onSynced={refresh} autoRefreshMs={3_600_000} />
      </header>

      {!report ? (
        <EmptyState loading={loading} />
      ) : (
        <div className="p-6 space-y-6">
          {/* PM-focused stats — no escalations */}
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <Stat
              icon={<Inbox className="h-4 w-4" />}
              label="Total FRs"
              value={stats.total}
            />
            <Stat
              icon={<Flame className="h-4 w-4 text-danger" />}
              label="High demand"
              hint="Demand score ≥ 7"
              value={stats.highDemand}
              tone="danger"
            />
            <Stat
              icon={<Clock className="h-4 w-4 text-warning" />}
              label="Aging in-flight"
              hint="Active/blocked, quiet 30+ days"
              value={stats.aging}
              tone="warning"
            />
            <Stat
              icon={<UserX className="h-4 w-4 text-warning" />}
              label="Unassigned"
              hint="Open FRs without an owner"
              value={stats.unassigned}
              tone="warning"
            />
            <Stat
              icon={<GitBranch className="h-4 w-4" />}
              label="Blocked"
              hint="Awaiting input / dependency"
              value={stats.blocked}
            />
          </div>

          {/* Macro flow: created vs resolved, WIP, backlog verdict */}
          <FrFlowTrend trend={report.trend} rows={rows} />

          {/* Committed roadmap: FRs by targeted month + child epics + dependencies */}
          <FrRoadmap />

          {/* Prioritization: the shared PM/EM build-order artifact */}
          <FrDemandValueMatrix rows={rows} onSelect={setSelected} />

          {/* Action layer + capacity, three aligned peers */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 items-start">
            <FrDecisionsNeeded rows={rows} onSelect={setSelected} />
            <FrTeamLoad rows={rows} onSelect={setSelected} />
            <FrBlocked rows={rows} onSelect={setSelected} />
          </div>

          {/* Status pipeline */}
          {totalForPipeline > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Status pipeline</CardTitle>
                <span className="text-[11px] text-fg-subtle">
                  {totalForPipeline} open FRs across {statusPipeline.length} statuses
                </span>
              </CardHeader>
              <CardBody className="space-y-3">
                {/* Proportional bar */}
                <div className="flex h-2 w-full rounded overflow-hidden bg-bg-muted border border-border">
                  {statusPipeline.map(([status, count], i) => {
                    const pct = (count / totalForPipeline) * 100;
                    return (
                      <div
                        key={status}
                        title={`${status} — ${count} (${pct.toFixed(0)}%)`}
                        className={cn(
                          "h-full",
                          STATUS_BAR_COLORS[i % STATUS_BAR_COLORS.length],
                        )}
                        style={{ width: `${pct}%` }}
                      />
                    );
                  })}
                </div>
                <div className="flex flex-wrap gap-2">
                  {statusPipeline.map(([status, count]) => (
                    <div
                      key={status}
                      className="flex items-center gap-1.5 text-xs"
                    >
                      <StatusChip status={status} />
                      <span className="text-fg font-mono">{count}</span>
                    </div>
                  ))}
                </div>
              </CardBody>
            </Card>
          )}

          {/* EM delivery: what's slotted for upcoming sprints + epic hygiene */}
          <FrSprintPlan rows={rows} onSelect={setSelected} />

          {/* PM demand analysis: themes, customer pull, triage coverage, dupes */}
          <FrDemandInsights rows={rows} onSelect={setSelected} />

          {/* White-glove customers — same as existing dashboard */}
          <section className="space-y-3">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold">White-glove customers</h2>
              <span className="text-xs text-fg-muted">
                {report.p0Summaries.length} tracked ·{" "}
                {report.p0Summaries.reduce((n, s) => n + s.openIssueKeys.length, 0)} FRs
              </span>
            </div>
            {report.p0Summaries.length > 0 ? (
              <div className="grid grid-cols-1 xl:grid-cols-2 gap-3 items-start">
                {report.p0Summaries.map((s) => (
                  <P0Card key={s.customer} summary={s} jiraBaseUrl={jiraBaseUrl} />
                ))}
              </div>
            ) : (
              <Card>
                <CardBody className="text-center text-fg-muted text-sm py-6">
                  No white-glove customers matched any FR.
                </CardBody>
              </Card>
            )}
          </section>

          {/* PM-focused FR queue */}
          <section>
            <FrPmTable rows={rows} onSelect={setSelected} />
          </section>
        </div>
      )}

      <TicketDrawer issueKey={selected} onClose={() => setSelected(null)} />
    </div>
  );
}

const STATUS_BAR_COLORS = [
  "bg-accent",
  "bg-warning",
  "bg-success",
  "bg-danger",
  "bg-temperature-cool",
  "bg-temperature-warm",
  "bg-temperature-hot",
  "bg-fg-muted",
];

function Stat({
  icon,
  label,
  hint,
  value,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  hint?: string;
  value: number;
  tone?: "danger" | "warning" | "success";
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
      <div className={`mt-1.5 text-2xl font-semibold ${toneCls}`}>{value}</div>
      {hint && <div className="mt-0.5 text-[10px] text-fg-subtle">{hint}</div>}
    </div>
  );
}

function EmptyState({ loading }: { loading: boolean }) {
  return (
    <div className="flex-1 flex items-center justify-center p-12">
      <div className="max-w-md text-center space-y-3">
        <div className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-accent/15 border border-accent/30">
          <Inbox className="h-5 w-5 text-accent" />
        </div>
        <h2 className="text-lg font-semibold">
          {loading ? "Loading…" : "No FR report yet"}
        </h2>
        <p className="text-sm text-fg-muted">
          Run <span className="text-fg">Sync FR from JIRA</span> to pull tickets and
          generate the first analysis.
        </p>
      </div>
    </div>
  );
}
