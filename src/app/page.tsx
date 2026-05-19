"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { SyncButton } from "@/components/sync-button";
import { P0Card } from "@/components/p0-card";
import { TriageTable } from "@/components/triage-table";
import { TicketDrawer } from "@/components/ticket-drawer";
import { CheckCircle2, MessageSquare, AlertTriangle, Inbox } from "lucide-react";
import type { JiraIssue, TriageReport } from "@/types/triage";

export default function DashboardPage() {
  const [report, setReport] = useState<TriageReport | null>(null);
  const [issues, setIssues] = useState<JiraIssue[]>([]);
  const [jiraBaseUrl, setJiraBaseUrl] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetch("/api/report").then((r) => r.json());
      setReport(data.report);
      setIssues(data.issues);
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

  const issueMap = useMemo(() => new Map(issues.map((i) => [i.key, i])), [issues]);

  return (
    <div className="flex-1 overflow-auto scroll-thin">
      <header className="px-6 h-14 border-b border-border flex items-center justify-between sticky top-0 z-10 bg-bg/90 backdrop-blur">
        <div>
          <h1 className="text-lg font-semibold">EAC Triage dashboard</h1>
          {report && (
            <p className="text-[11px] text-fg-subtle">
              Generated {new Date(report.generatedAt).toLocaleString()}
            </p>
          )}
        </div>
        <SyncButton onSynced={refresh} />
      </header>

      {!report ? (
        <EmptyState loading={loading} />
      ) : (
        <div className="p-6 space-y-6">
          {/* Top stats */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
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

          {/* P0 cards */}
          {report.p0Summaries.length > 0 && (
            <section className="space-y-3">
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-semibold">P0 customers</h2>
                <span className="text-xs text-fg-muted">
                  {report.p0Summaries.length} tracked ·{" "}
                  {report.p0Summaries.reduce((n, s) => n + s.openIssueKeys.length, 0)} tickets
                </span>
              </div>
              <div className="grid grid-cols-1 xl:grid-cols-2 gap-3 items-start">
                {report.p0Summaries.map((s) => (
                  <P0Card key={s.customer} summary={s} jiraBaseUrl={jiraBaseUrl} />
                ))}
              </div>
            </section>
          )}

          {/* Triage table */}
          <section>
            <TriageTable rows={rows} onSelect={setSelected} />
          </section>

          {/* Close + ping side-by-side */}
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

        </div>
      )}

      <TicketDrawer issueKey={selected} onClose={() => setSelected(null)} />
    </div>
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

function EmptyState({ loading }: { loading: boolean }) {
  return (
    <div className="flex-1 flex items-center justify-center p-12">
      <div className="max-w-md text-center space-y-3">
        <div className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-accent/15 border border-accent/30">
          <Inbox className="h-5 w-5 text-accent" />
        </div>
        <h2 className="text-lg font-semibold">
          {loading ? "Loading…" : "No triage report yet"}
        </h2>
        <p className="text-sm text-fg-muted">
          Configure your master JQL in <span className="text-fg">Settings</span>, add your{" "}
          <span className="text-fg">P0 customers</span>, then run <span className="text-fg">Sync from JIRA</span>{" "}
          to pull tickets and generate the first analysis.
        </p>
      </div>
    </div>
  );
}
