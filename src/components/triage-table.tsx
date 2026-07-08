"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  MessageSquare,
  XCircle,
  AlertTriangle,
  Clock,
  ArrowUpCircle,
  ArrowDownCircle,
  Unlink,
} from "lucide-react";
import { Badge, TempBadge } from "@/components/ui/badge";
import { cn, daysSince, formatDate } from "@/lib/utils";
import { hasEpicParent } from "@/types/triage";
import type { JiraIssue, Priority, SlaStatus, TicketAnalysis } from "@/types/triage";

type SortKey =
  | "rank"
  | "severity"
  | "temperature"
  | "updated"
  | "created"
  | "key"
  | "summary"
  | "customer"
  | "assignee"
  | "recommendation"
  | "sla"
  | "priority";

interface Row extends TicketAnalysis {
  issue: JiraIssue;
}

/** Ordering rank for SLA status — more urgent sorts first under "desc". */
const SLA_RANK: Record<SlaStatus, number> = {
  late: 4,
  "at-risk": 3,
  "on-track": 2,
  "best-effort": 1,
};

/** Ordering rank for priority — higher priority sorts first under "desc". */
const PRIORITY_RANK: Record<Priority, number> = { P0: 4, P1: 3, P2: 2, P3: 1 };

const RECOMMENDATION_STYLES: Record<TicketAnalysis["recommendation"], string> = {
  close: "border-fg-subtle/40 bg-fg-subtle/10 text-fg-muted",
  "ping-reporter": "border-warning/40 bg-warning/10 text-warning",
  "ping-assignee": "border-warning/40 bg-warning/10 text-warning",
  escalate: "border-danger/40 bg-danger/10 text-danger",
  continue: "border-success/40 bg-success/10 text-success",
  schedule: "border-accent/40 bg-accent/10 text-accent",
};

const SLA_STYLES: Record<SlaStatus, string> = {
  "on-track": "border-success/40 bg-success/10 text-success",
  "at-risk": "border-warning/40 bg-warning/10 text-warning",
  late: "border-danger/40 bg-danger/10 text-danger",
  "best-effort": "border-fg-subtle/40 bg-fg-subtle/10 text-fg-muted",
};

export function TriageTable({
  rows,
  onSelect,
  showSla = false,
  enabledPriorities,
  flagMissingEpic = false,
  showCreated = false,
  showAssignee = false,
  showScores = true,
  defaultSort,
}: {
  rows: Row[];
  onSelect: (key: string) => void;
  showSla?: boolean;
  /**
   * When provided, the in-table priority chip group only renders pills for
   * priorities in this set, and any in-table priority selection reverts to
   * "all" if its priority leaves the set.
   */
  enabledPriorities?: Set<Priority>;
  /**
   * When true, tickets whose parent is not an Epic get an alert icon by their
   * key — they need a manager to assign them to an epic.
   */
  flagMissingEpic?: boolean;
  /** When true, render a sortable "Created" column. */
  showCreated?: boolean;
  /** When true, render an "Assignee" column. */
  showAssignee?: boolean;
  /** When true, render the Sev and Temp score columns. */
  showScores?: boolean;
  /** Initial sort. Defaults to rank, descending. */
  defaultSort?: { key: SortKey; dir: "asc" | "desc" };
}) {
  const [sortKey, setSortKey] = useState<SortKey>(defaultSort?.key ?? "rank");
  const [sortDir, setSortDir] = useState<"asc" | "desc">(defaultSort?.dir ?? "desc");
  const [filter, setFilter] = useState<
    "all" | "p0" | "close" | "ping" | "escalate" | "late"
  >("all");
  const [priorityFilter, setPriorityFilter] = useState<"all" | Priority>("all");
  const [q, setQ] = useState("");

  // If the global filter removes the priority we're currently filtering on,
  // fall back to "all" so the table doesn't lock the user out of their own data.
  useEffect(() => {
    if (
      priorityFilter !== "all" &&
      enabledPriorities &&
      !enabledPriorities.has(priorityFilter)
    ) {
      setPriorityFilter("all");
    }
  }, [priorityFilter, enabledPriorities]);

  const filtered = useMemo(() => {
    let list = rows;
    if (filter === "p0") list = list.filter((r) => r.isP0Customer);
    if (filter === "close")
      list = list.filter((r) => r.recommendation === "close" || r.status === "ready-to-close");
    if (filter === "ping")
      list = list.filter(
        (r) => r.recommendation === "ping-reporter" || r.recommendation === "ping-assignee",
      );
    if (filter === "escalate") list = list.filter((r) => r.recommendation === "escalate");
    if (filter === "late") list = list.filter((r) => r.slaStatus === "late" || r.slaStatus === "at-risk");
    if (priorityFilter !== "all") {
      list = list.filter((r) => r.currentPriority === priorityFilter);
    }
    if (q.trim()) {
      const needle = q.toLowerCase();
      list = list.filter(
        (r) =>
          r.issueKey.toLowerCase().includes(needle) ||
          r.issue.summary.toLowerCase().includes(needle) ||
          (r.customer?.toLowerCase().includes(needle) ?? false) ||
          (r.issue.assignee?.toLowerCase().includes(needle) ?? false),
      );
    }
    const sorted = [...list].sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case "rank":
          cmp =
            (b.severityScore + b.temperatureScore) - (a.severityScore + a.temperatureScore);
          break;
        case "severity":
          cmp = b.severityScore - a.severityScore;
          break;
        case "temperature":
          cmp = b.temperatureScore - a.temperatureScore;
          break;
        case "updated":
          cmp = daysSince(a.issue.updated) - daysSince(b.issue.updated);
          break;
        case "created":
          // Newer (more recent created date) sorts first under "desc".
          cmp =
            new Date(b.issue.created).getTime() - new Date(a.issue.created).getTime();
          break;
        case "key":
          cmp = a.issueKey.localeCompare(b.issueKey);
          break;
        case "summary":
          cmp = a.issue.summary.localeCompare(b.issue.summary);
          break;
        case "customer":
          cmp = (a.customer ?? "").localeCompare(b.customer ?? "");
          break;
        case "assignee":
          cmp = (a.issue.assignee ?? "").localeCompare(b.issue.assignee ?? "");
          break;
        case "recommendation":
          cmp = a.recommendation.localeCompare(b.recommendation);
          break;
        case "sla":
          cmp = (b.slaStatus ? SLA_RANK[b.slaStatus] : 0) - (a.slaStatus ? SLA_RANK[a.slaStatus] : 0);
          break;
        case "priority":
          cmp =
            (b.currentPriority ? PRIORITY_RANK[b.currentPriority] : 0) -
            (a.currentPriority ? PRIORITY_RANK[a.currentPriority] : 0);
          break;
      }
      return sortDir === "asc" ? -cmp : cmp;
    });
    return sorted;
  }, [rows, sortKey, sortDir, filter, priorityFilter, q]);

  const counts = useMemo(
    () => ({
      all: rows.length,
      p0: rows.filter((r) => r.isP0Customer).length,
      close: rows.filter((r) => r.recommendation === "close" || r.status === "ready-to-close").length,
      ping: rows.filter(
        (r) => r.recommendation === "ping-reporter" || r.recommendation === "ping-assignee",
      ).length,
      escalate: rows.filter((r) => r.recommendation === "escalate").length,
      late: rows.filter(
        (r) => r.slaStatus === "late" || r.slaStatus === "at-risk",
      ).length,
      P0: rows.filter((r) => r.currentPriority === "P0").length,
      P1: rows.filter((r) => r.currentPriority === "P1").length,
      P2: rows.filter((r) => r.currentPriority === "P2").length,
      P3: rows.filter((r) => r.currentPriority === "P3").length,
    }),
    [rows],
  );

  const PRIORITY_CHIP_CLASS: Record<Priority, string> = {
    P0: "border-danger/40 bg-danger/10 text-danger",
    P1: "border-warning/40 bg-warning/10 text-warning",
    P2: "border-accent/40 bg-accent/10 text-accent",
    P3: "border-success/40 bg-success/10 text-success",
  };

  function clickSort(key: SortKey) {
    if (sortKey === key) setSortDir(sortDir === "asc" ? "desc" : "asc");
    else {
      setSortKey(key);
      setSortDir("desc");
    }
  }

  return (
    <div className="rounded border border-border bg-bg-card">
      <div className="px-4 py-3 border-b border-border flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold mr-2">Triage queue</h2>
        <div className="flex flex-wrap gap-1">
          <FilterChip active={filter === "all"} onClick={() => setFilter("all")}>
            All <span className="text-fg-subtle">· {counts.all}</span>
          </FilterChip>
          <FilterChip active={filter === "p0"} onClick={() => setFilter("p0")}>
            White-glove <span className="text-fg-subtle">· {counts.p0}</span>
          </FilterChip>
          <FilterChip active={filter === "escalate"} onClick={() => setFilter("escalate")}>
            <AlertTriangle className="h-3 w-3" /> Escalate <span className="text-fg-subtle">· {counts.escalate}</span>
          </FilterChip>
          <FilterChip active={filter === "ping"} onClick={() => setFilter("ping")}>
            <MessageSquare className="h-3 w-3" /> Ping <span className="text-fg-subtle">· {counts.ping}</span>
          </FilterChip>
          <FilterChip active={filter === "close"} onClick={() => setFilter("close")}>
            <XCircle className="h-3 w-3" /> Close <span className="text-fg-subtle">· {counts.close}</span>
          </FilterChip>
          {showSla && (
            <FilterChip active={filter === "late"} onClick={() => setFilter("late")}>
              <Clock className="h-3 w-3" /> Late SLA <span className="text-fg-subtle">· {counts.late}</span>
            </FilterChip>
          )}
          <span className="mx-1 h-4 w-px bg-border self-center" aria-hidden />
          <FilterChip
            active={priorityFilter === "all"}
            onClick={() => setPriorityFilter("all")}
          >
            All priorities
          </FilterChip>
          {(["P0", "P1", "P2", "P3"] as Priority[]).map((p) => {
            // Hide priorities the dashboard-wide filter has turned off.
            if (enabledPriorities && !enabledPriorities.has(p)) return null;
            const count = counts[p];
            if (count === 0 && priorityFilter !== p) return null;
            return (
              <FilterChip
                key={p}
                active={priorityFilter === p}
                onClick={() => setPriorityFilter(p)}
                className={priorityFilter === p ? PRIORITY_CHIP_CLASS[p] : undefined}
              >
                <span className="font-mono font-semibold">{p}</span>
                <span className="text-fg-subtle">· {count}</span>
              </FilterChip>
            );
          })}
        </div>
        <div className="ml-auto">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Filter by key, summary, customer…"
            className="h-7 rounded border border-border-strong bg-bg-muted px-2.5 text-xs w-64 placeholder:text-fg-subtle focus:outline-none focus:border-accent"
          />
        </div>
      </div>
      <div className="overflow-x-auto scroll-thin">
        <table className="w-full text-sm">
          <thead className="text-[11px] uppercase tracking-wide text-fg-subtle">
            <tr className="border-b border-border">
              <Th onClick={() => clickSort("key")} active={sortKey === "key"} dir={sortDir}>Key</Th>
              <Th onClick={() => clickSort("summary")} active={sortKey === "summary"} dir={sortDir}>Summary</Th>
              <Th onClick={() => clickSort("customer")} active={sortKey === "customer"} dir={sortDir}>Customer</Th>
              {showAssignee && (
                <Th onClick={() => clickSort("assignee")} active={sortKey === "assignee"} dir={sortDir}>Assignee</Th>
              )}
              {showScores && (
                <>
                  <Th onClick={() => clickSort("severity")} active={sortKey === "severity"} dir={sortDir}>Sev</Th>
                  <Th onClick={() => clickSort("temperature")} active={sortKey === "temperature"} dir={sortDir}>Temp</Th>
                </>
              )}
              <Th onClick={() => clickSort("recommendation")} active={sortKey === "recommendation"} dir={sortDir}>Recommendation</Th>
              {showSla && (
                <>
                  <Th onClick={() => clickSort("sla")} active={sortKey === "sla"} dir={sortDir}>SLA</Th>
                  <Th onClick={() => clickSort("priority")} active={sortKey === "priority"} dir={sortDir}>Pri</Th>
                </>
              )}
              {showCreated && (
                <Th onClick={() => clickSort("created")} active={sortKey === "created"} dir={sortDir}>Created</Th>
              )}
              <Th onClick={() => clickSort("updated")} active={sortKey === "updated"} dir={sortDir}>Updated</Th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => (
              <tr
                key={r.issueKey}
                onClick={() => onSelect(r.issueKey)}
                className="border-b border-border/50 hover:bg-bg-muted/60 cursor-pointer"
              >
                <td className="px-3 py-2 font-mono text-xs whitespace-nowrap">
                  <span className="text-accent">{r.issueKey}</span>
                  {r.isP0Customer && <span className="ml-1 text-warning">★</span>}
                  {flagMissingEpic && r.issue.parent !== undefined && !hasEpicParent(r.issue) && (
                    <span
                      className="ml-1 inline-flex align-text-bottom text-danger"
                      title="No epic parent — needs to be assigned to an epic"
                      aria-label="No epic parent — needs to be assigned to an epic"
                    >
                      <Unlink className="h-3.5 w-3.5" />
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 max-w-[420px] truncate">{r.issue.summary}</td>
                <td className="px-3 py-2 text-fg-muted whitespace-nowrap">{r.customer ?? "—"}</td>
                {showAssignee && (
                  <td className="px-3 py-2 text-fg-muted whitespace-nowrap max-w-[160px] truncate">
                    {r.issue.assignee ?? "—"}
                  </td>
                )}
                {showScores && (
                  <>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <span
                        className={cn(
                          "font-mono text-xs",
                          r.severityScore >= 8
                            ? "text-danger"
                            : r.severityScore >= 6
                              ? "text-warning"
                              : "text-fg-muted",
                        )}
                      >
                        {r.severityScore}/10
                      </span>
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <TempBadge band={r.temperature} score={r.temperatureScore} />
                    </td>
                  </>
                )}
                <td className="px-3 py-2 whitespace-nowrap">
                  <Badge className={cn("border", RECOMMENDATION_STYLES[r.recommendation])}>
                    {r.recommendation}
                  </Badge>
                </td>
                {showSla && (
                  <>
                    <td className="px-3 py-2 whitespace-nowrap">
                      {r.slaStatus ? (
                        <Badge className={cn("border", SLA_STYLES[r.slaStatus])}>
                          {r.slaStatus}
                        </Badge>
                      ) : (
                        <span className="text-fg-subtle text-xs">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <PriorityCell r={r} />
                    </td>
                  </>
                )}
                {showCreated && (
                  <td className="px-3 py-2 text-xs text-fg-muted whitespace-nowrap">
                    {formatDate(r.issue.created)}
                  </td>
                )}
                <td className="px-3 py-2 text-xs text-fg-muted whitespace-nowrap">
                  {daysSince(r.issue.updated)}d ago
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={7 + (showSla ? 2 : 0) + (showCreated ? 1 : 0) + (showAssignee ? 1 : 0) - (showScores ? 0 : 2)} className="px-3 py-8 text-center text-fg-muted text-sm">
                  No tickets match the current filter.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PriorityCell({ r }: { r: Row }) {
  if (!r.currentPriority && !r.recommendedPriority) {
    return <span className="text-fg-subtle text-xs">—</span>;
  }
  const change = r.priorityChange;
  return (
    <div className="flex items-center gap-1 text-xs">
      <span className="font-mono text-fg-muted">{r.currentPriority ?? "?"}</span>
      {change && change !== "keep" && (
        <>
          {change === "raise" ? (
            <ArrowUpCircle className="h-3 w-3 text-danger" />
          ) : (
            <ArrowDownCircle className="h-3 w-3 text-success" />
          )}
          <span
            className={cn(
              "font-mono font-semibold",
              change === "raise" ? "text-danger" : "text-success",
            )}
          >
            {r.recommendedPriority}
          </span>
        </>
      )}
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  children,
  className,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium border transition-colors",
        active
          ? className ?? "border-accent/50 bg-accent/15 text-accent"
          : "border-border bg-bg-muted text-fg-muted hover:text-fg",
      )}
    >
      {children}
    </button>
  );
}

function Th({
  onClick,
  active,
  dir,
  children,
}: {
  onClick: () => void;
  active: boolean;
  dir: "asc" | "desc";
  children: React.ReactNode;
}) {
  return (
    <th className="px-3 py-2 text-left font-medium">
      <button
        onClick={onClick}
        className={cn(
          "inline-flex items-center gap-1 hover:text-fg",
          active && "text-fg",
        )}
      >
        {children}
        {active &&
          (dir === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)}
      </button>
    </th>
  );
}
