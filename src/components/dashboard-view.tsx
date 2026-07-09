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
import { DefectGadgets } from "@/components/defect-gadgets";
import {
  CheckCircle2,
  MessageSquare,
  AlertTriangle,
  Inbox,
  Clock,
  Filter,
  Info,
} from "lucide-react";
import type {
  JiraIssue,
  P0Summary,
  Priority,
  PriorityDecision,
  ResolvedTicketRef,
  Scope,
  TicketAnalysis,
  TriageReport,
} from "@/types/triage";
import { SCOPE_LABELS, scopeHasP0 } from "@/types/triage";
import { computeSlaStatus, priorityFromString } from "@/lib/priority";
import { cn } from "@/lib/utils";

interface Props {
  scope: Scope;
  title: string;
}

type TogglePriority = "P0" | "P1" | "P2";
const TOGGLE_PRIORITIES: readonly TogglePriority[] = ["P0", "P1", "P2"] as const;
const STORAGE_KEY = "customer-dashboard-priorities";
const DEFAULT_STATE: Record<TogglePriority, boolean> = { P0: true, P1: true, P2: false };

function loadPriorityState(): Record<TogglePriority, boolean> {
  if (typeof window === "undefined") return { ...DEFAULT_STATE };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_STATE };
    const parsed = JSON.parse(raw) as Partial<Record<TogglePriority, boolean>>;
    return {
      P0: parsed.P0 ?? DEFAULT_STATE.P0,
      P1: parsed.P1 ?? DEFAULT_STATE.P1,
      P2: parsed.P2 ?? DEFAULT_STATE.P2,
    };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

function savePriorityState(state: Record<TogglePriority, boolean>) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* quota / disabled storage — ignore */
  }
}

/**
 * Unrated tickets (no `currentPriority`) are always visible. P3 is never
 * visible. Otherwise the priority must be in the active set.
 */
function makePriorityVisible(active: Record<TogglePriority, boolean>) {
  return (p: Priority | string | null | undefined): boolean => {
    const canonical = priorityFromString(p ?? null);
    if (canonical == null) return true;
    if (canonical === "P3") return false;
    return active[canonical as TogglePriority] === true;
  };
}

export function DashboardView({ scope, title }: Props) {
  const [report, setReport] = useState<TriageReport | null>(null);
  const [issues, setIssues] = useState<JiraIssue[]>([]);
  const [decisions, setDecisions] = useState<PriorityDecision[]>([]);
  const [jiraBaseUrl, setJiraBaseUrl] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [priorityActive, setPriorityActive] = useState<Record<TogglePriority, boolean>>(
    () => loadPriorityState(),
  );

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

  function togglePriority(p: TogglePriority) {
    setPriorityActive((prev) => {
      const next = { ...prev, [p]: !prev[p] };
      savePriorityState(next);
      return next;
    });
  }

  const filterApplies = scope === "eac";

  // Priority visibility test, conditional on whether the filter applies to this scope.
  const priorityVisible = useMemo(() => {
    if (!filterApplies) return () => true;
    return makePriorityVisible(priorityActive);
  }, [filterApplies, priorityActive]);

  // Tickets already in a done status category (e.g. a JQL that filters by status
  // name lets "Closed" through). They should never appear in the triage queue or
  // be recommended to close/ping — guard here regardless of the scope's JQL.
  const doneKeys = useMemo(
    () => new Set(issues.filter((i) => i.statusCategory === "done").map((i) => i.key)),
    [issues],
  );

  const rows = useMemo(() => {
    if (!report) return [];
    const map = new Map(issues.map((i) => [i.key, i]));
    return report.ticketAnalyses
      .map((a) => {
        const issue = map.get(a.issueKey);
        return issue ? { ...a, issue } : null;
      })
      .filter((x): x is NonNullable<typeof x> => Boolean(x))
      .filter((r) => r.issue.statusCategory !== "done");
  }, [report, issues]);

  const filteredAnalyses = useMemo<TicketAnalysis[]>(() => {
    if (!report) return [];
    return report.ticketAnalyses.filter(
      (a) => !doneKeys.has(a.issueKey) && (!filterApplies || priorityVisible(a.currentPriority)),
    );
  }, [report, filterApplies, priorityVisible, doneKeys]);

  const filteredRows = useMemo(() => {
    if (!filterApplies) return rows;
    return rows.filter((r) => priorityVisible(r.currentPriority));
  }, [rows, filterApplies, priorityVisible]);

  const filteredKeySet = useMemo(
    () => new Set(filteredAnalyses.map((a) => a.issueKey)),
    [filteredAnalyses],
  );

  const filteredCloseCandidates = useMemo(() => {
    if (!report) return [];
    return report.closeCandidates.filter(
      (k) => !doneKeys.has(k) && (!filterApplies || filteredKeySet.has(k)),
    );
  }, [report, filterApplies, filteredKeySet, doneKeys]);

  const filteredPingCandidates = useMemo(() => {
    if (!report) return [];
    return report.pingCandidates.filter(
      (p) => !doneKeys.has(p.issueKey) && (!filterApplies || filteredKeySet.has(p.issueKey)),
    );
  }, [report, filterApplies, filteredKeySet, doneKeys]);

  const filteredSummaries = useMemo<P0Summary[]>(() => {
    if (!report) return [];
    if (!filterApplies) return report.p0Summaries;
    const analysisByKey = new Map(report.ticketAnalyses.map((a) => [a.issueKey, a]));
    return report.p0Summaries.map((s) => {
      const openKeys = s.openIssueKeys.filter((k) => {
        const a = analysisByKey.get(k);
        return priorityVisible(a?.currentPriority);
      });
      const resolved = (s.resolvedTickets ?? []).filter((t: ResolvedTicketRef) =>
        priorityVisible(t.priority),
      );
      // A white-glove customer with no open P1 ticket is healthy by definition,
      // regardless of what the model inferred. Based on the customer's real open
      // tickets, not the filtered view.
      const hasOpenP1 = s.openIssueKeys.some(
        (k) => analysisByKey.get(k)?.currentPriority === "P1",
      );
      const health: P0Summary["health"] = hasOpenP1 ? s.health : "green";
      return { ...s, openIssueKeys: openKeys, resolvedTickets: resolved, health };
    });
  }, [report, filterApplies, priorityVisible]);

  const issueMap = useMemo(() => new Map(issues.map((i) => [i.key, i])), [issues]);

  const enabledPrioritySet = useMemo(() => {
    const s = new Set<Priority>();
    if (priorityActive.P0) s.add("P0");
    if (priorityActive.P1) s.add("P1");
    if (priorityActive.P2) s.add("P2");
    return s;
  }, [priorityActive]);

  const anyPriorityEnabled =
    priorityActive.P0 || priorityActive.P1 || priorityActive.P2;

  // Open P1 tickets past their SLA fix window (from creation date). Shown on the
  // All Defects dashboard in place of the Escalations stat.
  const pastSlaP1Count = useMemo(() => {
    if (scope !== "alldefects") return 0;
    return filteredRows.filter((r) => {
      const p = priorityFromString(r.issue.priority);
      return p === "P1" && !r.issue.resolved && computeSlaStatus(p, r.issue.created) === "late";
    }).length;
  }, [scope, filteredRows]);

  return (
    <div className="flex-1 overflow-auto scroll-thin">
      <header className="px-6 h-14 border-b border-border flex items-center justify-between sticky top-0 z-10 bg-bg/90 backdrop-blur">
        <h1 className="text-lg font-semibold">{title}</h1>
        <SyncButton scope={scope} onSynced={refresh} autoRefreshMs={3_600_000} />
      </header>

      {!report ? (
        <EmptyState loading={loading} scope={scope} />
      ) : (
        <div className="p-6 space-y-6">
          {filterApplies && (
            <PriorityFilterBar
              active={priorityActive}
              onToggle={togglePriority}
            />
          )}

          {filterApplies && !anyPriorityEnabled ? (
            <Card>
              <CardBody className="text-center text-fg-muted text-sm py-10 space-y-2">
                <Filter className="h-5 w-5 text-fg-subtle mx-auto" />
                <p>All priority filters are off.</p>
                <p className="text-xs text-fg-subtle">
                  Enable at least one of P0, P1, P2 above to view tickets.
                </p>
              </CardBody>
            </Card>
          ) : (
            <>
              <div
                className={`grid grid-cols-2 ${scope === "eac" ? "md:grid-cols-5" : "md:grid-cols-4"} gap-3`}
              >
                <Stat
                  icon={<Inbox className="h-4 w-4" />}
                  label="Tickets analyzed"
                  value={filteredAnalyses.length}
                />
                {scope === "alldefects" ? (
                  <Stat
                    icon={<Clock className="h-4 w-4 text-danger" />}
                    label="P1 past SLA"
                    value={pastSlaP1Count}
                    tone="danger"
                  />
                ) : (
                  <Stat
                    icon={<AlertTriangle className="h-4 w-4 text-danger" />}
                    label="Escalations"
                    value={filteredAnalyses.filter((a) => a.recommendation === "escalate").length}
                    tone="danger"
                  />
                )}
                {scope === "eac" && (
                  <Stat
                    icon={<Clock className="h-4 w-4 text-danger" />}
                    label="Late on SLA"
                    value={
                      filteredAnalyses.filter(
                        (a) => a.slaStatus === "late" || a.slaStatus === "at-risk",
                      ).length
                    }
                    tone="danger"
                  />
                )}
                <Stat
                  icon={<MessageSquare className="h-4 w-4 text-warning" />}
                  label="Need a ping"
                  value={filteredPingCandidates.length}
                  tone="warning"
                />
                <Stat
                  icon={<CheckCircle2 className="h-4 w-4 text-success" />}
                  label="Close candidates"
                  value={filteredCloseCandidates.length}
                  tone="success"
                />
              </div>

              {scope === "eac" && report.trend && report.trend.length > 0 && (
                <Card>
                  <CardHeader>
                    <CardTitle>30-day ticket trend</CardTitle>
                    <span className="text-[11px] text-fg-subtle">
                      Created vs Resolved within the configured project · all priorities
                    </span>
                  </CardHeader>
                  <CardBody>
                    <TrendChart data={report.trend} />
                  </CardBody>
                </Card>
              )}

              {scopeHasP0(scope) && (
                <section className="space-y-3">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h2 className="text-sm font-semibold">White-glove customers</h2>
                    <span className="text-xs text-fg-muted">
                      {filteredSummaries.length} tracked
                    </span>
                    <WhiteGloveTicketsLinks
                      analyses={filteredAnalyses}
                      jiraBaseUrl={jiraBaseUrl}
                    />
                  </div>
                  {filteredSummaries.length > 0 ? (
                    <div className="grid grid-cols-1 xl:grid-cols-2 gap-3 items-start">
                      {filteredSummaries.map((s) => (
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
                          no white-glove customers are configured in{" "}
                          <a href="/settings" className="text-accent underline">
                            Settings
                          </a>
                          .
                        </p>
                      </CardBody>
                    </Card>
                  )}
                </section>
              )}

              {scope === "alldefects" && (
                <DefectGadgets rows={filteredRows} jiraBaseUrl={jiraBaseUrl} />
              )}

              <section>
                <TriageTable
                  rows={filteredRows}
                  onSelect={setSelected}
                  showSla={scope === "eac"}
                  enabledPriorities={filterApplies ? enabledPrioritySet : undefined}
                  flagMissingEpic={
                    scope === "sec" ||
                    scope === "alerts" ||
                    scope === "incidents" ||
                    scope === "alldefects" ||
                    scope === "ops"
                  }
                  showCreated={scope === "sec"}
                  showAssignee
                  showScores={false}
                  showPing={scope === "eac"}
                  defaultSort={scope === "sec" ? { key: "created", dir: "desc" } : undefined}
                />
              </section>

              <section className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <CheckCircle2 className="h-4 w-4 text-success" /> Close candidates
                    </CardTitle>
                    <Badge>{filteredCloseCandidates.length}</Badge>
                  </CardHeader>
                  <CardBody className="max-h-72 overflow-auto scroll-thin">
                    {filteredCloseCandidates.length === 0 ? (
                      <p className="text-fg-muted text-sm">Nothing to close right now.</p>
                    ) : (
                      <ul className="space-y-1.5 text-sm">
                        {filteredCloseCandidates.map((k) => {
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
                    <Badge>{filteredPingCandidates.length}</Badge>
                  </CardHeader>
                  <CardBody className="max-h-72 overflow-auto scroll-thin">
                    {filteredPingCandidates.length === 0 ? (
                      <p className="text-fg-muted text-sm">Inbox zero on pings.</p>
                    ) : (
                      <ul className="space-y-1.5 text-sm">
                        {filteredPingCandidates.map((p) => {
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
                  rows={filteredRows}
                  decisions={decisions}
                  onSelect={setSelected}
                  onDecisionsChanged={refreshDecisions}
                />
              )}
            </>
          )}
        </div>
      )}

      <TicketDrawer issueKey={selected} onClose={() => setSelected(null)} />
    </div>
  );
}

const PRIORITY_PILL_ACTIVE: Record<TogglePriority, string> = {
  P0: "border-danger/50 bg-danger/15 text-danger",
  P1: "border-warning/50 bg-warning/15 text-warning",
  P2: "border-accent/50 bg-accent/15 text-accent",
};

function PriorityFilterBar({
  active,
  onToggle,
}: {
  active: Record<TogglePriority, boolean>;
  onToggle: (p: TogglePriority) => void;
}) {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="inline-flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-fg-muted">
        <Filter className="h-3 w-3" /> Priority filter
      </span>
      {TOGGLE_PRIORITIES.map((p) => {
        const on = active[p];
        return (
          <button
            key={p}
            onClick={() => onToggle(p)}
            aria-pressed={on}
            className={cn(
              "inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-mono font-semibold border transition-colors",
              on
                ? PRIORITY_PILL_ACTIVE[p]
                : "border-border bg-bg-muted text-fg-subtle hover:text-fg-muted",
            )}
            title={on ? `Hide ${p} tickets` : `Show ${p} tickets`}
          >
            <span
              className={cn(
                "inline-block h-1.5 w-1.5 rounded-full",
                on ? "bg-current" : "bg-fg-subtle/50",
              )}
            />
            {p}
          </button>
        );
      })}
      <span className="inline-flex items-center gap-1 text-[10px] text-fg-subtle">
        <Info className="h-3 w-3" />
        Unrated tickets always shown · P3 always hidden
      </span>
    </div>
  );
}

function WhiteGloveTicketsLinks({
  analyses,
  jiraBaseUrl,
}: {
  analyses: TriageReport["ticketAnalyses"];
  jiraBaseUrl: string;
}) {
  // Group open white-glove tickets by current JIRA priority.
  const PRIORITY_ORDER: Array<"P0" | "P1" | "P2" | "P3"> = ["P0", "P1", "P2", "P3"];
  const PRIORITY_STYLE: Record<string, string> = {
    P0: "text-danger hover:text-danger decoration-danger/40 hover:decoration-danger",
    P1: "text-warning hover:text-warning decoration-warning/40 hover:decoration-warning",
    P2: "text-accent hover:text-accent-hover decoration-accent/40 hover:decoration-accent",
    P3: "text-success hover:text-success decoration-success/40 hover:decoration-success",
  };
  const byPriority = new Map<string, string[]>();
  for (const a of analyses) {
    if (!a.isP0Customer) continue;
    if (a.status === "resolved") continue;
    if (!a.currentPriority) continue;
    const arr = byPriority.get(a.currentPriority) ?? [];
    arr.push(a.issueKey);
    byPriority.set(a.currentPriority, arr);
  }
  const present = PRIORITY_ORDER.filter((p) => (byPriority.get(p)?.length ?? 0) > 0);
  if (present.length === 0 || !jiraBaseUrl) {
    const total = Array.from(byPriority.values()).reduce((n, v) => n + v.length, 0);
    return <span className="text-xs text-fg-muted">· {total} tickets</span>;
  }
  return (
    <span className="text-xs text-fg-muted inline-flex items-center gap-1.5 flex-wrap">
      {present.map((p, i) => {
        const keys = byPriority.get(p)!;
        const jql = `key in (${keys.join(",")}) ORDER BY priority DESC, updated DESC`;
        const href = `${jiraBaseUrl}/issues/?jql=${encodeURIComponent(jql)}`;
        return (
          <span key={p}>
            {i === 0 && <span className="text-fg-subtle">· </span>}
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              className={`underline ${PRIORITY_STYLE[p]}`}
              title={`Open the ${keys.length} ${p} white-glove ticket${keys.length === 1 ? "" : "s"} in JIRA`}
            >
              <span className="font-mono font-semibold">{keys.length} {p}</span>
            </a>
            {i < present.length - 1 && <span className="text-fg-subtle"> · </span>}
          </span>
        );
      })}
    </span>
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
