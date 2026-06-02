"use client";

import { useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Search,
  X,
  CheckSquare,
  Square,
  Star,
  AlertTriangle,
  Clock,
  ChevronDown,
  ChevronRight,
  SlidersHorizontal,
} from "lucide-react";
import { Badge, TempBadge } from "@/components/ui/badge";
import { StatusChip } from "@/components/jira-chips";
import { cn, daysSince } from "@/lib/utils";
import type { JiraIssue, TemperatureBand, TicketAnalysis } from "@/types/triage";

interface Row extends TicketAnalysis {
  issue: JiraIssue;
}

type SortKey =
  | "demand"
  | "value"
  | "age"
  | "updated"
  | "status"
  | "customer"
  | "key";

const AGE_BUCKETS = [
  { id: "all" as const, label: "Any age" },
  { id: "lt14" as const, label: "< 14d", test: (d: number) => d < 14 },
  { id: "14-30" as const, label: "14-30d", test: (d: number) => d >= 14 && d < 30 },
  { id: "30-90" as const, label: "30-90d", test: (d: number) => d >= 30 && d < 90 },
  { id: "gte90" as const, label: "≥ 90d", test: (d: number) => d >= 90 },
];
type AgeBucket = (typeof AGE_BUCKETS)[number]["id"];

const TEMP_BANDS: TemperatureBand[] = ["cold", "cool", "warm", "hot", "critical"];

export function FrPmTable({
  rows,
  onSelect,
}: {
  rows: Row[];
  onSelect: (key: string) => void;
}) {
  const [sortKey, setSortKey] = useState<SortKey>("demand");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [q, setQ] = useState("");
  const [statusSel, setStatusSel] = useState<Set<string>>(new Set());
  const [tempSel, setTempSel] = useState<Set<TemperatureBand>>(new Set());
  const [customerSel, setCustomerSel] = useState<Set<string>>(new Set());
  const [age, setAge] = useState<AgeBucket>("all");
  const [wgOnly, setWgOnly] = useState(false);
  const [unassignedOnly, setUnassignedOnly] = useState(false);
  // One master toggle hides every filter row. Search + heading remain
  // visible; active filters appear as removable pills underneath the header
  // even when collapsed so the user never loses sight of what's filtering.
  const [filtersOpen, setFiltersOpen] = useState(false);

  const facets = useMemo(() => {
    const statuses = new Map<string, number>();
    const customers = new Map<string, number>();
    for (const r of rows) {
      const s = r.issue.status;
      statuses.set(s, (statuses.get(s) ?? 0) + 1);
      if (r.customer) {
        customers.set(r.customer, (customers.get(r.customer) ?? 0) + 1);
      }
    }
    return {
      statuses: Array.from(statuses.entries()).sort((a, b) => b[1] - a[1]),
      customers: Array.from(customers.entries()).sort((a, b) => b[1] - a[1]),
    };
  }, [rows]);

  const filtered = useMemo(() => {
    let list = rows;
    if (wgOnly) list = list.filter((r) => r.isP0Customer);
    if (unassignedOnly) list = list.filter((r) => !r.issue.assignee);
    if (statusSel.size > 0) list = list.filter((r) => statusSel.has(r.issue.status));
    if (tempSel.size > 0) list = list.filter((r) => tempSel.has(r.temperature));
    if (customerSel.size > 0)
      list = list.filter((r) => r.customer && customerSel.has(r.customer));
    if (age !== "all") {
      const bucket = AGE_BUCKETS.find((b) => b.id === age);
      if (bucket && "test" in bucket && bucket.test) {
        list = list.filter((r) => bucket.test(daysSince(r.issue.created)));
      }
    }
    if (q.trim()) {
      const needle = q.toLowerCase();
      list = list.filter(
        (r) =>
          r.issueKey.toLowerCase().includes(needle) ||
          r.issue.summary.toLowerCase().includes(needle) ||
          (r.customer?.toLowerCase().includes(needle) ?? false) ||
          (r.issue.description?.toLowerCase().includes(needle) ?? false) ||
          (r.issue.assignee?.toLowerCase().includes(needle) ?? false) ||
          (r.issue.reporter?.toLowerCase().includes(needle) ?? false),
      );
    }
    const sorted = [...list].sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case "demand":
          cmp = b.temperatureScore - a.temperatureScore;
          break;
        case "value":
          cmp = b.severityScore - a.severityScore;
          break;
        case "age":
          cmp = daysSince(b.issue.created) - daysSince(a.issue.created);
          break;
        case "updated":
          cmp = daysSince(a.issue.updated) - daysSince(b.issue.updated);
          break;
        case "status":
          cmp = a.issue.status.localeCompare(b.issue.status);
          break;
        case "customer":
          cmp = (a.customer ?? "~~").localeCompare(b.customer ?? "~~");
          break;
        case "key":
          cmp = a.issueKey.localeCompare(b.issueKey);
          break;
      }
      return sortDir === "asc" ? -cmp : cmp;
    });
    return sorted;
  }, [
    rows,
    q,
    statusSel,
    tempSel,
    customerSel,
    age,
    wgOnly,
    unassignedOnly,
    sortKey,
    sortDir,
  ]);

  function clickSort(key: SortKey) {
    if (sortKey === key) setSortDir(sortDir === "asc" ? "desc" : "asc");
    else {
      setSortKey(key);
      setSortDir("desc");
    }
  }

  const activeFilterCount =
    (statusSel.size > 0 ? 1 : 0) +
    (tempSel.size > 0 ? 1 : 0) +
    (customerSel.size > 0 ? 1 : 0) +
    (age !== "all" ? 1 : 0) +
    (wgOnly ? 1 : 0) +
    (unassignedOnly ? 1 : 0);

  function clearAll() {
    setStatusSel(new Set());
    setTempSel(new Set());
    setCustomerSel(new Set());
    setAge("all");
    setWgOnly(false);
    setUnassignedOnly(false);
    setQ("");
  }

  return (
    <div className="rounded border border-border bg-bg-card">
      <div className="px-4 py-3 border-b border-border space-y-2.5">
        <div className="flex items-center gap-2 flex-wrap">
          <h2 className="text-sm font-semibold mr-1">FR queue</h2>
          <span className="text-xs text-fg-muted">
            {filtered.length} of {rows.length}
          </span>
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={() => setFiltersOpen((v) => !v)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded border px-2 h-7 text-[11px] font-medium transition-colors",
                filtersOpen || activeFilterCount > 0
                  ? "border-accent/50 bg-accent/15 text-accent"
                  : "border-border bg-bg-muted text-fg-muted hover:text-fg",
              )}
              aria-expanded={filtersOpen}
            >
              {filtersOpen ? (
                <ChevronDown className="h-3 w-3" />
              ) : (
                <ChevronRight className="h-3 w-3" />
              )}
              <SlidersHorizontal className="h-3 w-3" />
              Filters
              {activeFilterCount > 0 && (
                <span className="rounded-full bg-accent/30 text-accent px-1.5 py-px text-[10px] font-mono">
                  {activeFilterCount}
                </span>
              )}
            </button>
            {activeFilterCount > 0 && (
              <button
                onClick={clearAll}
                className="inline-flex items-center gap-1 text-[11px] text-fg-muted hover:text-fg"
              >
                <X className="h-3 w-3" /> Clear all
              </button>
            )}
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-fg-subtle" />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search key, title, customer, requirements…"
                className="h-7 rounded border border-border-strong bg-bg-muted pl-7 pr-2 text-xs w-72 placeholder:text-fg-subtle focus:outline-none focus:border-accent"
              />
            </div>
          </div>
        </div>

        {/* Active filter pills shown when the panel is collapsed so the user
            can see what's filtering and remove individual filters quickly. */}
        {!filtersOpen && activeFilterCount > 0 && (
          <div className="flex items-center gap-1 flex-wrap text-[11px]">
            <span className="text-fg-subtle">Active:</span>
            {wgOnly && (
              <ActiveChip label="white-glove only" onRemove={() => setWgOnly(false)} />
            )}
            {unassignedOnly && (
              <ActiveChip label="unassigned" onRemove={() => setUnassignedOnly(false)} />
            )}
            {age !== "all" && (
              <ActiveChip
                label={`age: ${AGE_BUCKETS.find((b) => b.id === age)?.label ?? age}`}
                onRemove={() => setAge("all")}
              />
            )}
            {[...tempSel].map((band) => (
              <ActiveChip
                key={`t-${band}`}
                label={`demand: ${band}`}
                onRemove={() =>
                  setTempSel((p) => {
                    const n = new Set(p);
                    n.delete(band);
                    return n;
                  })
                }
              />
            ))}
            {[...statusSel].map((s) => (
              <ActiveChip
                key={`s-${s}`}
                label={s}
                onRemove={() =>
                  setStatusSel((p) => {
                    const n = new Set(p);
                    n.delete(s);
                    return n;
                  })
                }
              />
            ))}
            {[...customerSel].map((c) => (
              <ActiveChip
                key={`c-${c}`}
                label={c}
                onRemove={() =>
                  setCustomerSel((p) => {
                    const n = new Set(p);
                    n.delete(c);
                    return n;
                  })
                }
              />
            ))}
          </div>
        )}

        {filtersOpen && (
          <div className="space-y-2.5 pt-1 border-t border-border">
            <div className="flex items-center gap-1 flex-wrap text-[11px]">
              <ToggleChip
                active={wgOnly}
                onClick={() => setWgOnly((v) => !v)}
                icon={<Star className="h-3 w-3" />}
                label="White-glove only"
              />
              <ToggleChip
                active={unassignedOnly}
                onClick={() => setUnassignedOnly((v) => !v)}
                icon={<AlertTriangle className="h-3 w-3" />}
                label="Unassigned"
              />
              <span className="mx-1 h-4 w-px bg-border self-center" aria-hidden />
              <span className="text-fg-subtle flex items-center gap-1">
                <Clock className="h-3 w-3" /> Age:
              </span>
              {AGE_BUCKETS.map((b) => (
                <ToggleChip
                  key={b.id}
                  active={age === b.id}
                  onClick={() => setAge(b.id)}
                  label={b.label}
                />
              ))}
            </div>

            <div className="flex items-center gap-1 flex-wrap text-[11px]">
              <span className="text-fg-subtle">Demand:</span>
              {TEMP_BANDS.map((band) => {
                const count = rows.filter((r) => r.temperature === band).length;
                if (count === 0 && !tempSel.has(band)) return null;
                return (
                  <ToggleChip
                    key={band}
                    active={tempSel.has(band)}
                    onClick={() => {
                      setTempSel((prev) => {
                        const next = new Set(prev);
                        if (next.has(band)) next.delete(band);
                        else next.add(band);
                        return next;
                      });
                    }}
                    label={
                      <span className="inline-flex items-center gap-1">
                        {band}
                        <span className="text-fg-subtle">{count}</span>
                      </span>
                    }
                  />
                );
              })}
            </div>

            {facets.statuses.length > 0 && (
              <div className="flex items-start gap-1 flex-wrap text-[11px]">
                <span className="text-fg-subtle pt-0.5 shrink-0">Status:</span>
                {facets.statuses.map(([status, count]) => (
                  <ToggleChip
                    key={status}
                    active={statusSel.has(status)}
                    onClick={() => {
                      setStatusSel((prev) => {
                        const next = new Set(prev);
                        if (next.has(status)) next.delete(status);
                        else next.add(status);
                        return next;
                      });
                    }}
                    label={
                      <span className="inline-flex items-center gap-1">
                        {status}
                        <span className="text-fg-subtle">{count}</span>
                      </span>
                    }
                  />
                ))}
              </div>
            )}

            {facets.customers.length > 0 && (
              <div className="flex items-start gap-1 flex-wrap text-[11px]">
                <span className="text-fg-subtle pt-0.5 shrink-0">Customer:</span>
                {facets.customers.slice(0, 12).map(([customer, count]) => (
                  <ToggleChip
                    key={customer}
                    active={customerSel.has(customer)}
                    onClick={() => {
                      setCustomerSel((prev) => {
                        const next = new Set(prev);
                        if (next.has(customer)) next.delete(customer);
                        else next.add(customer);
                        return next;
                      });
                    }}
                    label={
                      <span className="inline-flex items-center gap-1">
                        {customer}
                        <span className="text-fg-subtle">{count}</span>
                      </span>
                    }
                  />
                ))}
                {facets.customers.length > 12 && (
                  <span className="text-fg-subtle pt-0.5">
                    +{facets.customers.length - 12} more
                  </span>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="overflow-x-auto scroll-thin">
        <table className="w-full text-sm">
          <thead className="text-[11px] uppercase tracking-wide text-fg-subtle">
            <tr className="border-b border-border">
              <Th onClick={() => clickSort("key")} active={sortKey === "key"} dir={sortDir}>
                Key
              </Th>
              <th className="px-3 py-2 text-left font-medium">Title &amp; requirements</th>
              <Th
                onClick={() => clickSort("customer")}
                active={sortKey === "customer"}
                dir={sortDir}
              >
                Customer
              </Th>
              <Th
                onClick={() => clickSort("demand")}
                active={sortKey === "demand"}
                dir={sortDir}
              >
                Demand
              </Th>
              <Th
                onClick={() => clickSort("value")}
                active={sortKey === "value"}
                dir={sortDir}
              >
                Value
              </Th>
              <Th
                onClick={() => clickSort("status")}
                active={sortKey === "status"}
                dir={sortDir}
              >
                Status
              </Th>
              <Th onClick={() => clickSort("age")} active={sortKey === "age"} dir={sortDir}>
                Age
              </Th>
              <Th
                onClick={() => clickSort("updated")}
                active={sortKey === "updated"}
                dir={sortDir}
              >
                Updated
              </Th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => (
              <tr
                key={r.issueKey}
                onClick={() => onSelect(r.issueKey)}
                className="border-b border-border/50 hover:bg-bg-muted/60 cursor-pointer align-top"
              >
                <td className="px-3 py-2 font-mono text-xs whitespace-nowrap">
                  <span className="text-accent">{r.issueKey}</span>
                  {r.isP0Customer && (
                    <span className="ml-1 text-warning" title="White-glove customer">
                      ★
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 max-w-[480px]">
                  <div className="text-fg font-medium truncate">{r.issue.summary}</div>
                  {r.issue.description && (
                    <div className="mt-0.5 text-[11px] text-fg-muted line-clamp-2">
                      {r.issue.description}
                    </div>
                  )}
                </td>
                <td className="px-3 py-2 text-fg-muted whitespace-nowrap text-xs">
                  {r.customer ?? "—"}
                </td>
                <td className="px-3 py-2 whitespace-nowrap">
                  <TempBadge band={r.temperature} score={r.temperatureScore} />
                </td>
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
                  <StatusChip status={r.issue.status} />
                </td>
                <td className="px-3 py-2 text-xs text-fg-muted whitespace-nowrap">
                  {daysSince(r.issue.created)}d
                </td>
                <td className="px-3 py-2 text-xs text-fg-muted whitespace-nowrap">
                  {daysSince(r.issue.updated)}d ago
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={8} className="px-3 py-8 text-center text-fg-muted text-sm">
                  No FRs match the current filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ActiveChip({
  label,
  onRemove,
}: {
  label: string;
  onRemove: () => void;
}) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 border border-accent/40 bg-accent/10 text-accent">
      {label}
      <button
        onClick={onRemove}
        className="hover:text-fg"
        aria-label={`Remove ${label} filter`}
      >
        <X className="h-3 w-3" />
      </button>
    </span>
  );
}

function ToggleChip({
  active,
  onClick,
  label,
  icon,
}: {
  active: boolean;
  onClick: () => void;
  label: React.ReactNode;
  icon?: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 border transition-colors",
        active
          ? "border-accent/50 bg-accent/15 text-accent"
          : "border-border bg-bg-muted text-fg-muted hover:text-fg",
      )}
    >
      {icon ?? (active ? <CheckSquare className="h-3 w-3" /> : <Square className="h-3 w-3" />)}
      <span>{label}</span>
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
        className={cn("inline-flex items-center gap-1 hover:text-fg", active && "text-fg")}
      >
        {children}
        {active && (dir === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)}
      </button>
    </th>
  );
}

// Re-export Badge so the import isn't a leak — keeps tree-shaking happy.
export const _BadgeProbe = Badge;
