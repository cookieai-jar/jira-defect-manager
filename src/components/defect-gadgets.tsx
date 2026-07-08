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

/** All Defects analytics gadgets. Every count deep-links to the ticket set in JIRA. */
export function DefectGadgets({ rows, jiraBaseUrl }: { rows: Row[]; jiraBaseUrl: string }) {
  const issues = useMemo(() => rows.map((r) => r.issue), [rows]);

  const priorityDist = useMemo(() => {
    const order: (Priority | "Unset")[] = ["P0", "P1", "P2", "P3", "Unset"];
    const g = groupKeys(issues, (i) => priorityFromString(i.priority) ?? "Unset");
    return order
      .map((p) => ({ label: p, issueKeys: g.get(p) ?? [], barClass: PRIORITY_BAR[p] }))
      .filter((d) => d.issueKeys.length > 0);
  }, [issues]);

  const assigneeDist = useMemo(
    () => topN(groupKeys(issues, (i) => i.assignee ?? "Unassigned"), 8),
    [issues],
  );

  const statusDist = useMemo(
    () => sortedGroups(groupKeys(issues, (i) => i.status)),
    [issues],
  );

  const customerDist = useMemo(() => {
    const withC = issues.filter((i) => i.customers.length > 0).map((i) => i.key);
    const without = issues.filter((i) => i.customers.length === 0).map((i) => i.key);
    return [
      { label: "Customer-linked", issueKeys: withC, barClass: "bg-accent" },
      { label: "No customer", issueKeys: without, barClass: "bg-fg-subtle" },
    ].filter((d) => d.issueKeys.length > 0);
  }, [issues]);

  const pastSla = useMemo(() => {
    const late = issues.filter(
      (i) => !i.resolved && computeSlaStatus(priorityFromString(i.priority), i.created) === "late",
    );
    const g = groupKeys(late, (i) => priorityFromString(i.priority) ?? "Unset");
    const order: (Priority | "Unset")[] = ["P0", "P1", "P2", "P3", "Unset"];
    return {
      allKeys: late.map((i) => i.key),
      breakdown: order
        .map((p) => ({ label: p, issueKeys: g.get(p) ?? [], barClass: PRIORITY_BAR[p] }))
        .filter((d) => d.issueKeys.length > 0),
    };
  }, [issues]);

  const total = issues.length;

  return (
    <section className="space-y-3">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <GadgetCard title="Priority distribution" icon={<Flag className="h-4 w-4" />}>
          <BarList data={priorityDist} total={total} jiraBaseUrl={jiraBaseUrl} />
        </GadgetCard>

        <GadgetCard title="Status distribution" icon={<ListChecks className="h-4 w-4" />}>
          <BarList data={statusDist} total={total} jiraBaseUrl={jiraBaseUrl} />
        </GadgetCard>

        <GadgetCard
          title="Past SLA due date"
          icon={<Clock className="h-4 w-4 text-danger" />}
          subtitle="Open tickets past the fix window for their priority (from creation date)"
        >
          <div className="flex items-baseline gap-2 mb-3">
            <CountLink
              keys={pastSla.allKeys}
              jiraBaseUrl={jiraBaseUrl}
              className={cn(
                "text-3xl font-semibold",
                pastSla.allKeys.length > 0 ? "text-danger" : "text-fg",
              )}
            >
              {pastSla.allKeys.length}
            </CountLink>
            <span className="text-xs text-fg-muted">
              of {total} open ({pct(pastSla.allKeys.length, total)}%)
            </span>
          </div>
          {pastSla.breakdown.length > 0 && (
            <BarList data={pastSla.breakdown} total={pastSla.allKeys.length} jiraBaseUrl={jiraBaseUrl} />
          )}
        </GadgetCard>

        <GadgetCard title="Assignee distribution" icon={<UserRound className="h-4 w-4" />}>
          <BarList data={assigneeDist} total={total} jiraBaseUrl={jiraBaseUrl} />
        </GadgetCard>

        <GadgetCard title="Customer vs non-customer" icon={<Users className="h-4 w-4" />}>
          <BarList data={customerDist} total={total} jiraBaseUrl={jiraBaseUrl} />
        </GadgetCard>

        <CategorizationGadget issues={issues} jiraBaseUrl={jiraBaseUrl} />
      </div>
    </section>
  );
}

/* ---------- Categorization gadget (LLM-backed) ---------- */

function CategorizationGadget({
  issues,
  jiraBaseUrl,
}: {
  issues: JiraIssue[];
  jiraBaseUrl: string;
}) {
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
            data={cat.categories.map((c) => ({
              label: c.name,
              issueKeys: c.issueKeys,
              barClass: "bg-accent",
            }))}
            total={cat.total}
            jiraBaseUrl={jiraBaseUrl}
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
  issueKeys: string[];
  barClass?: string;
}

function BarList({
  data,
  total,
  jiraBaseUrl,
}: {
  data: BarDatum[];
  total: number;
  jiraBaseUrl: string;
}) {
  if (data.length === 0) {
    return <p className="text-sm text-fg-muted">No data.</p>;
  }
  const max = Math.max(...data.map((d) => d.issueKeys.length), 1);
  return (
    <ul className="space-y-1.5">
      {data.map((d) => {
        const count = d.issueKeys.length;
        return (
          <li key={d.label} className="flex items-center gap-2 text-xs">
            <span className="w-32 shrink-0 truncate text-fg-muted" title={d.label}>
              {d.label}
            </span>
            <span className="flex-1 h-4 rounded bg-bg-muted overflow-hidden">
              <span
                className={cn("block h-full rounded", d.barClass ?? "bg-accent")}
                style={{ width: `${Math.max((count / max) * 100, 2)}%` }}
              />
            </span>
            <span className="w-16 shrink-0 text-right font-mono">
              <CountLink keys={d.issueKeys} jiraBaseUrl={jiraBaseUrl} className="text-fg">
                {count}
              </CountLink>
              <span className="text-fg-subtle"> · {pct(count, total)}%</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Render a count that links to the exact ticket set in JIRA. Falls back to
 * plain text when there are no keys or the JIRA base URL is unknown.
 */
function CountLink({
  keys,
  jiraBaseUrl,
  className,
  children,
}: {
  keys: string[];
  jiraBaseUrl: string;
  className?: string;
  children: React.ReactNode;
}) {
  if (!jiraBaseUrl || keys.length === 0) {
    return <span className={className}>{children}</span>;
  }
  const jql = `key in (${keys.join(",")}) ORDER BY priority DESC, created ASC`;
  const href = `${jiraBaseUrl}/issues/?jql=${encodeURIComponent(jql)}`;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className={cn("underline decoration-fg-subtle/40 hover:decoration-accent hover:text-accent", className)}
      title={`Open these ${keys.length} ticket${keys.length === 1 ? "" : "s"} in JIRA`}
    >
      {children}
    </a>
  );
}

/* ---------- pure helpers ---------- */

/** Group issue keys by a derived label. */
function groupKeys(issues: JiraIssue[], label: (i: JiraIssue) => string): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const i of issues) {
    const k = label(i);
    const arr = m.get(k);
    if (arr) arr.push(i.key);
    else m.set(k, [i.key]);
  }
  return m;
}

function sortedGroups(m: Map<string, string[]>): BarDatum[] {
  return [...m.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([label, issueKeys]) => ({ label, issueKeys }));
}

/** Top N groups by size, folding the remainder into an "Others" row. */
function topN(m: Map<string, string[]>, n: number): BarDatum[] {
  const sorted = [...m.entries()].sort((a, b) => b[1].length - a[1].length);
  const head: BarDatum[] = sorted.slice(0, n).map(([label, issueKeys]) => ({ label, issueKeys }));
  const rest = sorted.slice(n);
  if (rest.length > 0) {
    head.push({
      label: `Others (${rest.length})`,
      issueKeys: rest.flatMap(([, keys]) => keys),
    });
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
