"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { SyncButton } from "@/components/sync-button";
import { P0Card } from "@/components/p0-card";
import { TriageTable } from "@/components/triage-table";
import { TicketDrawer } from "@/components/ticket-drawer";
import { TrendChart } from "@/components/trend-chart";
import { PriorityReview } from "@/components/priority-review";
import { CheckCircle2, MessageSquare, AlertTriangle, Inbox, Clock } from "lucide-react";
import type { JiraIssue, PriorityDecision, Scope, TriageReport } from "@/types/triage";
import { SCOPE_LABELS, scopeHasP0 } from "@/types/triage";

interface Props {
  scope: Scope;
  title: string;
}

export function DashboardView({ scope, title }: Props) {
  const [report, setReport] = useState<TriageReport | null>(null);
  const [issues, setIssues] = useState<JiraIssue[]>([]);
  const [decisions, setDecisions] = useState<PriorityDecision[]>([]);
  const [jiraBaseUrl, setJiraBaseUrl] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetch(`/api/report?scope=${scope}`).then((r) => r.json());
      setReport(data.report);
      setIssues(data.issues ?? []);
      setDecisions(data.decisions ?? []);
      setJiraBaseUrl(data.jiraBaseUrl ?? "");
    } finally {
      setLoading(false);
    }
  }, [scope]);

  const refreshDecisions = useCallback(async () => {
    try {
      const ds = (await fetch("/api/priority-decisions").then((r) => r.json())) as PriorityDecision[];
      setDecisions(Array.isArray(ds) ? ds : []);
    } catch {
      // ignore
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

  const issueMap = useMemo(() => new Map(issues.map((i) => [i.key, i])), [issues]);

  return (
    <div className="flex-1 overflow-auto scroll-thin">
      <header className="px-6 h-14 border-b border-border flex items-center justify-between sticky top-0 z-10 bg-bg/90 backdrop-blur">
        <div>
          <h1 className="text-lg font-semibold">{title}</h1>
          {report && (
            <p className="text-[11px] text-fg-subtle">
              Generated {new Date(report.generatedAt).toLocaleString()}
            </p>
          )}
        </div>
        <SyncButton scope={scope} onSynced={refresh} />
      </header>

      {!report ? (
        <EmptyState loading={loading} scope={scope} />
      ) : (
        <div className="p-6 space-y-6">
          <div
            className={`grid grid-cols-2 ${scope === "eac" ? "md:grid-cols-5" : "md:grid-cols-4"} gap-3`}
          >
            <Stat
              icon={<Inbox className="h-4 w-4" />}
              label="Tickets analyzed"
              value={report.ticketAnalyses.length}
            />
            <Stat
              icon={<AlertTriangle className="h-4 w-4 text-danger" />}
              label="Escalations"
              value={report.ticketAnalyses.filter((a) => a.recommendation === "escalate").length}
              tone="danger"
            />
            {scope === "eac" && (
              <Stat
                icon={<Clock className="h-4 w-4 text-danger" />}
                label="Late on SLA"
                value={
                  report.ticketAnalyses.filter(
                    (a) => a.slaStatus === "late" || a.slaStatus === "at-risk",
                  ).length
                }
                tone="danger"
              />
            )}
            <Stat
              icon={<MessageSquare className="h-4 w-4 text-warning" />}
              label="Need a ping"
              value={report.pingCandidates.length}
              tone="warning"
            />
            <Stat
              icon={<CheckCircle2 className="h-4 w-4 text-success" />}
              label="Close candidates"
              value={report.closeCandidates.length}
              tone="success"
            />
          </div>

          {scope === "eac" && report.trend && report.trend.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>30-day ticket trend</CardTitle>
                <span className="text-[11px] text-fg-subtle">
                  Created vs Resolved within the configured project
                </span>
              </CardHeader>
              <CardBody>
                <TrendChart data={report.trend} />
              </CardBody>
            </Card>
          )}

          {scopeHasP0(scope) && (
            <section className="space-y-3">
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-semibold">White-glove customers</h2>
                <span className="text-xs text-fg-muted">
                  {report.p0Summaries.length} tracked ·{" "}
                  <WhiteGloveTicketsLink
                    summaries={report.p0Summaries}
                    jiraBaseUrl={jiraBaseUrl}
                  />
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
                  <CardBody className="text-center text-fg-muted text-sm py-8 space-y-2">
                    <p>
                      No white-glove customers matched any open {SCOPE_LABELS[scope]} tickets yet.
                    </p>
                    <p className="text-xs text-fg-subtle">
                      Either no customer&apos;s JQL fragment matches a {SCOPE_LABELS[scope]} ticket, or
                      no white-glove customers are configured on the{" "}
                      <a href="/p0" className="text-accent underline">
                        White-glove Customers
                      </a>{" "}
                      page.
                    </p>
                  </CardBody>
                </Card>
              )}
            </section>
          )}

          <section>
            <TriageTable
              rows={rows}
              onSelect={setSelected}
              showSla={scope === "eac"}
            />
          </section>

          <section className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4 text-success" /> Close candidates
                </CardTitle>
                <Badge>{report.closeCandidates.length}</Badge>
              </CardHeader>
              <CardBody className="max-h-72 overflow-auto scroll-thin">
                {report.closeCandidates.length === 0 ? (
                  <p className="text-fg-muted text-sm">Nothing to close right now.</p>
                ) : (
                  <ul className="space-y-1.5 text-sm">
                    {report.closeCandidates.map((k) => {
                      const issue = issueMap.get(k);
                      return (
                        <li
                          key={k}
                          className="flex items-baseline gap-2 cursor-pointer hover:bg-bg-muted/60 rounded px-2 py-1 -mx-2"
                          onClick={() => setSelected(k)}
                        >
                          <span className="font-mono text-xs text-accent">{k}</span>
                          <span className="text-fg-muted truncate">{issue?.summary ?? ""}</span>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </CardBody>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <MessageSquare className="h-4 w-4 text-warning" /> Needs a ping
                </CardTitle>
                <Badge>{report.pingCandidates.length}</Badge>
              </CardHeader>
              <CardBody className="max-h-72 overflow-auto scroll-thin">
                {report.pingCandidates.length === 0 ? (
                  <p className="text-fg-muted text-sm">Inbox zero on pings.</p>
                ) : (
                  <ul className="space-y-1.5 text-sm">
                    {report.pingCandidates.map((p) => {
                      const issue = issueMap.get(p.issueKey);
                      return (
                        <li
                          key={p.issueKey}
                          className="flex items-baseline gap-2 cursor-pointer hover:bg-bg-muted/60 rounded px-2 py-1 -mx-2"
                          onClick={() => setSelected(p.issueKey)}
                        >
                          <span className="font-mono text-xs text-accent">{p.issueKey}</span>
                          <Badge className="border-warning/40 bg-warning/10 text-warning border">
                            ping {p.target}
                          </Badge>
                          <span className="text-fg-muted truncate">{issue?.summary ?? ""}</span>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </CardBody>
            </Card>
          </section>

          {scope === "eac" && (
            <PriorityReview
              rows={rows}
              decisions={decisions}
              onSelect={setSelected}
              onDecisionsChanged={refreshDecisions}
            />
          )}
        </div>
      )}

      <TicketDrawer issueKey={selected} onClose={() => setSelected(null)} />
    </div>
  );
}

function WhiteGloveTicketsLink({
  summaries,
  jiraBaseUrl,
}: {
  summaries: TriageReport["p0Summaries"];
  jiraBaseUrl: string;
}) {
  const allKeys = summaries.flatMap((s) => s.openIssueKeys);
  const count = allKeys.length;
  if (count === 0 || !jiraBaseUrl) {
    return <>{count} tickets</>;
  }
  const jql = `key in (${allKeys.join(",")}) ORDER BY priority DESC, updated DESC`;
  const href = `${jiraBaseUrl}/issues/?jql=${encodeURIComponent(jql)}`;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-accent hover:text-accent-hover underline decoration-accent/40 hover:decoration-accent"
      title="Open all open white-glove customer tickets in JIRA"
    >
      {count} tickets
    </a>
  );
}

function Stat({
  icon,
  label,
  value,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
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
    </div>
  );
}

function EmptyState({ loading, scope }: { loading: boolean; scope: Scope }) {
  return (
    <div className="flex-1 flex items-center justify-center p-12">
      <div className="max-w-md text-center space-y-3">
        <div className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-accent/15 border border-accent/30">
          <Inbox className="h-5 w-5 text-accent" />
        </div>
        <h2 className="text-lg font-semibold">
          {loading ? "Loading…" : `No ${SCOPE_LABELS[scope]} report yet`}
        </h2>
        <p className="text-sm text-fg-muted">
          Configure the {SCOPE_LABELS[scope]} JQL in <span className="text-fg">Settings</span>
          {scopeHasP0(scope) && (
            <>
              , add your <span className="text-fg">white-glove customers</span>
            </>
          )}
          , then run <span className="text-fg">Sync {SCOPE_LABELS[scope]} from JIRA</span> to pull
          tickets and generate the first analysis.
        </p>
      </div>
    </div>
  );
}
