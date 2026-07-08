"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Loader2, Sparkles, Clock, Users, ListChecks, Flag, UserRound } from "lucide-react";
import type { JiraIssue, Priority, TicketAnalysis } from "@/types/triage";
import { computeSlaStatus, priorityFromString } from "@/lib/priority";
import {
  fingerprintIssues,
  type DefectCategorization,
} from "@/lib/defect-categorize-core";
import { cn } from "@/lib/utils";

interface Row extends TicketAnalysis {
  issue: JiraIssue;
}

const PRIORITY_BAR: Record<Priority | "Unset", string> = {
  P0: "bg-danger",
  P1: "bg-warning",
  P2: "bg-accent",
  P3: "bg-success",
  Unset: "bg-fg-subtle",
};

/** All Defects analytics gadgets. Read-only distributions over the open ticket set. */
export function DefectGadgets({ rows }: { rows: Row[] }) {
  const issues = useMemo(() => rows.map((r) => r.issue), [rows]);

  const priorityDist = useMemo(() => {
    const order: (Priority | "Unset")[] = ["P0", "P1", "P2", "P3", "Unset"];
    const counts = new Map<string, number>();
    for (const i of issues) {
      const p = priorityFromString(i.priority) ?? "Unset";
      counts.set(p, (counts.get(p) ?? 0) + 1);
    }
    return order
      .map((p) => ({ label: p, count: counts.get(p) ?? 0, barClass: PRIORITY_BAR[p] }))
      .filter((d) => d.count > 0);
  }, [issues]);

  const assigneeDist = useMemo(() => topN(countBy(issues, (i) => i.assignee ?? "Unassigned"), 8), [
    issues,
  ]);

  const statusDist = useMemo(
    () => sortedEntries(countBy(issues, (i) => i.status)),
    [issues],
  );

  const customerDist = useMemo(() => {
    let withC = 0;
    for (const i of issues) if (i.customers.length > 0) withC++;
    return [
      { label: "Customer-linked", count: withC, barClass: "bg-accent" },
      { label: "No customer", count: issues.length - withC, barClass: "bg-fg-subtle" },
    ].filter((d) => d.count > 0);
  }, [issues]);

  const pastSla = useMemo(() => {
    const byPriority = new Map<string, number>();
    let total = 0;
    for (const i of issues) {
      if (i.resolved) continue;
      const p = priorityFromString(i.priority);
      if (computeSlaStatus(p, i.created) !== "late") continue;
      total++;
      const k = p ?? "Unset";
      byPriority.set(k, (byPriority.get(k) ?? 0) + 1);
    }
    const order: (Priority | "Unset")[] = ["P0", "P1", "P2", "P3", "Unset"];
    return {
      total,
      breakdown: order
        .map((p) => ({ label: p, count: byPriority.get(p) ?? 0, barClass: PRIORITY_BAR[p] }))
        .filter((d) => d.count > 0),
    };
  }, [issues]);

  const total = issues.length;

  return (
    <section className="space-y-3">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <GadgetCard title="Priority distribution" icon={<Flag className="h-4 w-4" />}>
          <BarList data={priorityDist} total={total} />
        </GadgetCard>

        <GadgetCard title="Status distribution" icon={<ListChecks className="h-4 w-4" />}>
          <BarList data={statusDist} total={total} />
        </GadgetCard>

        <GadgetCard title="Assignee distribution" icon={<UserRound className="h-4 w-4" />}>
          <BarList data={assigneeDist} total={total} />
        </GadgetCard>

        <GadgetCard
          title="Customer vs non-customer"
          icon={<Users className="h-4 w-4" />}
        >
          <BarList data={customerDist} total={total} />
        </GadgetCard>

        <GadgetCard
          title="Past SLA due date"
          icon={<Clock className="h-4 w-4 text-danger" />}
          subtitle="Open tickets past the fix window for their priority (from creation date)"
        >
          <div className="flex items-baseline gap-2 mb-3">
            <span className={cn("text-3xl font-semibold", pastSla.total > 0 ? "text-danger" : "text-fg")}>
              {pastSla.total}
            </span>
            <span className="text-xs text-fg-muted">
              of {total} open ({pct(pastSla.total, total)}%)
            </span>
          </div>
          {pastSla.breakdown.length > 0 && <BarList data={pastSla.breakdown} total={pastSla.total} />}
        </GadgetCard>

        <CategorizationGadget issues={issues} />
      </div>
    </section>
  );
}

/* ---------- Categorization gadget (LLM-backed) ---------- */

function CategorizationGadget({ issues }: { issues: JiraIssue[] }) {
  const [cat, setCat] = useState<DefectCategorization | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const currentFingerprint = useMemo(() => fingerprintIssues(issues), [issues]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/all-defects/categorize")
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled) setCat(d.categorization ?? null);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const run = useCallback(async () => {
    setRunning(true);
    setError(null);
    try {
      const res = await fetch("/api/all-defects/categorize", { method: "POST" });
      const d = await res.json();
      if (!res.ok) {
        setError(d.error ?? "Analysis failed.");
        return;
      }
      setCat(d.categorization ?? null);
    } catch {
      setError("Analysis failed.");
    } finally {
      setRunning(false);
    }
  }, []);

  const stale = cat != null && cat.fingerprint !== currentFingerprint;

  return (
    <GadgetCard
      title="Defect categorization"
      icon={<Sparkles className="h-4 w-4 text-accent" />}
      subtitle="AI classification of defects by primary failure mode"
      action={
        <Button onClick={run} disabled={running} className="h-7 text-xs">
          {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
          {running ? "Analyzing…" : cat ? "Re-analyze" : "Analyze"}
        </Button>
      }
    >
      {loading ? (
        <p className="text-sm text-fg-muted flex items-center gap-2">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
        </p>
      ) : error ? (
        <p className="text-sm text-danger">{error}</p>
      ) : !cat ? (
        <p className="text-sm text-fg-muted">
          Not analyzed yet. Click <span className="text-fg">Analyze</span> to classify the{" "}
          {issues.length} open defects.
        </p>
      ) : (
        <>
          {stale && (
            <p className="text-[11px] text-warning mb-2">
              Stale — the ticket set changed since this ran. Re-analyze to refresh.
            </p>
          )}
          <BarList
            data={cat.categories.map((c) => ({ label: c.name, count: c.count, barClass: "bg-accent" }))}
            total={cat.total}
          />
          <p className="text-[11px] text-fg-subtle mt-2">
            {cat.total} tickets · analyzed {formatWhen(cat.categorizedAt)}
          </p>
        </>
      )}
    </GadgetCard>
  );
}

/* ---------- Presentational helpers ---------- */

function GadgetCard({
  title,
  icon,
  subtitle,
  action,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  subtitle?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-2">
        <div>
          <CardTitle className="flex items-center gap-2">
            {icon} {title}
          </CardTitle>
          {subtitle && <span className="text-[11px] text-fg-subtle">{subtitle}</span>}
        </div>
        {action}
      </CardHeader>
      <CardBody>{children}</CardBody>
    </Card>
  );
}

interface BarDatum {
  label: string;
  count: number;
  barClass?: string;
}

function BarList({ data, total }: { data: BarDatum[]; total: number }) {
  if (data.length === 0) {
    return <p className="text-sm text-fg-muted">No data.</p>;
  }
  const max = Math.max(...data.map((d) => d.count), 1);
  return (
    <ul className="space-y-1.5">
      {data.map((d) => (
        <li key={d.label} className="flex items-center gap-2 text-xs">
          <span className="w-32 shrink-0 truncate text-fg-muted" title={d.label}>
            {d.label}
          </span>
          <span className="flex-1 h-4 rounded bg-bg-muted overflow-hidden">
            <span
              className={cn("block h-full rounded", d.barClass ?? "bg-accent")}
              style={{ width: `${Math.max((d.count / max) * 100, 2)}%` }}
            />
          </span>
          <span className="w-16 shrink-0 text-right font-mono text-fg">
            {d.count}
            <span className="text-fg-subtle"> · {pct(d.count, total)}%</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/* ---------- pure helpers ---------- */

function countBy<T>(items: T[], key: (t: T) => string): Map<string, number> {
  const m = new Map<string, number>();
  for (const it of items) {
    const k = key(it);
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
}

function sortedEntries(m: Map<string, number>): BarDatum[] {
  return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([label, count]) => ({ label, count }));
}

/** Top N by count, folding the remainder into an "Others" row. */
function topN(m: Map<string, number>, n: number): BarDatum[] {
  const sorted = [...m.entries()].sort((a, b) => b[1] - a[1]);
  const head = sorted.slice(0, n).map(([label, count]) => ({ label, count }));
  const rest = sorted.slice(n);
  if (rest.length > 0) {
    head.push({ label: `Others (${rest.length})`, count: rest.reduce((s, [, c]) => s + c, 0) });
  }
  return head;
}

function pct(n: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((n / total) * 100);
}

function formatWhen(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
