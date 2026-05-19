"use client";

import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, MessageSquare, XCircle, AlertTriangle } from "lucide-react";
import { Badge, TempBadge } from "@/components/ui/badge";
import { cn, daysSince } from "@/lib/utils";
import type { JiraIssue, TicketAnalysis } from "@/types/triage";

type SortKey = "rank" | "severity" | "temperature" | "updated" | "key";

interface Row extends TicketAnalysis {
  issue: JiraIssue;
}

const RECOMMENDATION_STYLES: Record<TicketAnalysis["recommendation"], string> = {
  close: "border-fg-subtle/40 bg-fg-subtle/10 text-fg-muted",
  "ping-reporter": "border-warning/40 bg-warning/10 text-warning",
  "ping-assignee": "border-warning/40 bg-warning/10 text-warning",
  escalate: "border-danger/40 bg-danger/10 text-danger",
  continue: "border-success/40 bg-success/10 text-success",
  schedule: "border-accent/40 bg-accent/10 text-accent",
};

export function TriageTable({
  rows,
  onSelect,
}: {
  rows: Row[];
  onSelect: (key: string) => void;
}) {
  const [sortKey, setSortKey] = useState<SortKey>("rank");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [filter, setFilter] = useState<"all" | "p0" | "close" | "ping" | "escalate">("all");
  const [q, setQ] = useState("");

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
        case "key":
          cmp = a.issueKey.localeCompare(b.issueKey);
          break;
      }
      return sortDir === "asc" ? -cmp : cmp;
    });
    return sorted;
  }, [rows, sortKey, sortDir, filter, q]);

  const counts = useMemo(
    () => ({
      all: rows.length,
      p0: rows.filter((r) => r.isP0Customer).length,
      close: rows.filter((r) => r.recommendation === "close" || r.status === "ready-to-close").length,
      ping: rows.filter(
        (r) => r.recommendation === "ping-reporter" || r.recommendation === "ping-assignee",
      ).length,
      escalate: rows.filter((r) => r.recommendation === "escalate").length,
    }),
    [rows],
  );

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
            P0 customers <span className="text-fg-subtle">· {counts.p0}</span>
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
              <th className="px-3 py-2 text-left font-medium">Summary</th>
              <th className="px-3 py-2 text-left font-medium">Customer</th>
              <Th onClick={() => clickSort("severity")} active={sortKey === "severity"} dir={sortDir}>Sev</Th>
              <Th onClick={() => clickSort("temperature")} active={sortKey === "temperature"} dir={sortDir}>Temp</Th>
              <th className="px-3 py-2 text-left font-medium">Recommendation</th>
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
                </td>
                <td className="px-3 py-2 max-w-[420px] truncate">{r.issue.summary}</td>
                <td className="px-3 py-2 text-fg-muted whitespace-nowrap">{r.customer ?? "—"}</td>
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
                <td className="px-3 py-2 whitespace-nowrap">
                  <Badge className={cn("border", RECOMMENDATION_STYLES[r.recommendation])}>
                    {r.recommendation}
                  </Badge>
                </td>
                <td className="px-3 py-2 text-xs text-fg-muted whitespace-nowrap">
                  {daysSince(r.issue.updated)}d ago
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-8 text-center text-fg-muted text-sm">
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

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium border transition-colors",
        active
          ? "border-accent/50 bg-accent/15 text-accent"
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
