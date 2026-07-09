"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  AlertTriangle,
  Clock,
  MessageSquare,
  XCircle,
  Inbox,
  ChevronRight,
  ExternalLink,
  Loader2,
  RefreshCw,
} from "lucide-react";
import type { ActionItem, ActionKind, Overview } from "@/lib/overview-core";
import { cn } from "@/lib/utils";

const KIND_META: Record<ActionKind, { label: string; icon: typeof AlertTriangle; cls: string }> = {
  escalate: { label: "Escalate", icon: AlertTriangle, cls: "border-danger/40 bg-danger/10 text-danger" },
  sla: { label: "Past SLA", icon: Clock, cls: "border-danger/40 bg-danger/10 text-danger" },
  ping: { label: "Ping", icon: MessageSquare, cls: "border-warning/40 bg-warning/10 text-warning" },
  close: { label: "Close", icon: XCircle, cls: "border-fg-subtle/40 bg-fg-subtle/10 text-fg-muted" },
};

const KIND_ORDER: (ActionKind | "all")[] = ["all", "escalate", "sla", "ping", "close"];

export function OverviewView() {
  const [data, setData] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<ActionKind | "all">("all");

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const d = (await fetch("/api/overview").then((r) => r.json())) as Overview;
      setData(d);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const actions = useMemo(() => {
    if (!data) return [];
    return filter === "all" ? data.actions : data.actions.filter((a) => a.kind === filter);
  }, [data, filter]);

  return (
    <div className="flex-1 overflow-auto scroll-thin">
      <header className="px-6 h-14 border-b border-border flex items-center justify-between sticky top-0 z-10 bg-bg/90 backdrop-blur">
        <div>
          <h1 className="text-lg font-semibold">Overview</h1>
          <p className="text-[11px] text-fg-subtle">
            Cross-dashboard triage — what needs action now
          </p>
        </div>
        <Button onClick={refresh} disabled={loading} className="h-8 text-xs">
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          Refresh
        </Button>
      </header>

      {!data ? (
        <div className="p-6 flex items-center gap-2 text-fg-muted text-sm">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : (
        <div className="p-6 space-y-6 max-w-6xl">
          {/* Totals */}
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <TotalStat icon={<Inbox className="h-4 w-4" />} label="Open tickets" value={data.totals.open} />
            <TotalStat
              icon={<AlertTriangle className="h-4 w-4 text-danger" />}
              label="Escalations"
              value={data.totals.escalations}
              tone="danger"
            />
            <TotalStat
              icon={<Clock className="h-4 w-4 text-danger" />}
              label="Past SLA"
              value={data.totals.pastSla}
              tone="danger"
            />
            <TotalStat
              icon={<MessageSquare className="h-4 w-4 text-warning" />}
              label="Need a ping"
              value={data.totals.needPing}
              tone="warning"
            />
            <TotalStat
              icon={<XCircle className="h-4 w-4 text-success" />}
              label="Close candidates"
              value={data.totals.closeCandidates}
              tone="success"
            />
          </div>

          {/* Per-dashboard summary cards (drill-in) */}
          <section className="space-y-2">
            <h2 className="text-sm font-semibold text-fg-muted">Dashboards</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {data.scopes.map((s) => (
                <Link key={s.scope} href={s.href} className="group">
                  <Card className="hover:border-border-strong transition-colors h-full">
                    <CardHeader>
                      <CardTitle className="flex items-center gap-1.5">
                        {s.label}
                        <ChevronRight className="h-3.5 w-3.5 text-fg-subtle group-hover:text-accent transition-colors" />
                      </CardTitle>
                      <Badge>{s.synced ? `${s.open} open` : "not synced"}</Badge>
                    </CardHeader>
                    <CardBody>
                      {s.synced ? (
                        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-fg-muted">
                          <MiniStat n={s.escalations} label="escalate" tone="danger" />
                          <MiniStat n={s.pastSla} label="past SLA" tone="danger" />
                          <MiniStat n={s.needPing} label="ping" tone="warning" />
                          <MiniStat n={s.closeCandidates} label="close" />
                          {s.redCustomers != null && s.redCustomers > 0 && (
                            <MiniStat n={s.redCustomers} label="red WG" tone="danger" />
                          )}
                        </div>
                      ) : (
                        <p className="text-xs text-fg-subtle">
                          Sync this dashboard to populate its summary.
                        </p>
                      )}
                    </CardBody>
                  </Card>
                </Link>
              ))}
            </div>
          </section>

          {/* Action queue */}
          <section className="space-y-2">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-sm font-semibold text-fg-muted">Action queue</h2>
              <span className="text-xs text-fg-subtle">{data.totals.actions} tasks</span>
              <div className="ml-auto flex flex-wrap gap-1">
                {KIND_ORDER.map((k) => {
                  const count =
                    k === "all" ? data.actions.length : data.actions.filter((a) => a.kind === k).length;
                  return (
                    <button
                      key={k}
                      onClick={() => setFilter(k)}
                      className={cn(
                        "rounded-full border px-2.5 py-1 text-xs transition-colors",
                        filter === k
                          ? "border-accent bg-accent/10 text-fg"
                          : "border-border text-fg-muted hover:text-fg",
                      )}
                    >
                      {k === "all" ? "All" : KIND_META[k].label}
                      <span className="text-fg-subtle"> · {count}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {actions.length === 0 ? (
              <Card>
                <CardBody className="text-center text-fg-muted text-sm py-10">
                  Nothing needs action here — inbox zero. 🎉
                </CardBody>
              </Card>
            ) : (
              <Card>
                <ul className="divide-y divide-border/60">
                  {actions.map((a) => (
                    <ActionRow key={`${a.scope}:${a.issueKey}`} a={a} />
                  ))}
                </ul>
              </Card>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

function ActionRow({ a }: { a: ActionItem }) {
  const meta = KIND_META[a.kind];
  const Icon = meta.icon;
  return (
    <li className="flex items-center gap-3 px-4 py-2.5 hover:bg-bg-muted/50">
      <Badge className={cn("border shrink-0", meta.cls)}>
        <Icon className="h-3 w-3" /> {meta.label}
      </Badge>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <a
            href={a.url}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-xs text-accent hover:underline inline-flex items-center gap-1 shrink-0"
            title="Open in JIRA"
          >
            {a.issueKey} <ExternalLink className="h-3 w-3" />
          </a>
          {a.isP0Customer && <span className="text-warning text-xs" title="White-glove customer">★</span>}
          <span className="truncate text-sm">{a.summary}</span>
        </div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-fg-subtle mt-0.5">
          <Link href={a.href} className="hover:text-accent">
            {a.scopeLabel}
          </Link>
          {a.priority && <span>· {a.priority}</span>}
          {a.customer && <span>· {a.customer}</span>}
          {a.assignee && <span>· {a.assignee}</span>}
          <span>· {a.daysSinceUpdate}d idle</span>
          <span className="text-fg-muted">· {a.nextStep}</span>
        </div>
      </div>
    </li>
  );
}

function TotalStat({
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

function MiniStat({
  n,
  label,
  tone,
}: {
  n: number;
  label: string;
  tone?: "danger" | "warning";
}) {
  const cls = n === 0 ? "text-fg-subtle" : tone === "danger" ? "text-danger" : tone === "warning" ? "text-warning" : "text-fg";
  return (
    <span className="inline-flex items-baseline gap-1">
      <span className={`font-mono font-semibold ${cls}`}>{n}</span>
      <span>{label}</span>
    </span>
  );
}
