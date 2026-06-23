"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge, HealthBadge } from "@/components/ui/badge";
import { StatusChip } from "@/components/jira-chips";
import { cn } from "@/lib/utils";
import {
  AlertTriangle,
  Boxes,
  ExternalLink,
  HeartPulse,
  Inbox,
  Network,
  PlugZap,
  RefreshCw,
  Ticket,
  TriangleAlert,
} from "lucide-react";
import type {
  GraphWrite,
  IntegrationHealth,
  Severity,
  TenantAlert,
  TenantHealthReport,
  TenantJiraTicket,
} from "@/types/tenant";

const TENANT = "bcgprod";

interface ReportResponse {
  report: TenantHealthReport | null;
  error?: string;
}

const SEVERITY_RANK: Record<Severity, number> = { critical: 0, warning: 1, ok: 2 };

function severityBadgeClass(severity: Severity): string {
  if (severity === "critical") return "border-danger/40 bg-danger/10 text-danger";
  if (severity === "warning") return "border-warning/40 bg-warning/10 text-warning";
  return "border-fg-subtle/40 bg-fg-subtle/10 text-fg-muted";
}

function healthTone(score: number): "green" | "yellow" | "red" {
  if (score >= 80) return "green";
  if (score >= 50) return "yellow";
  return "red";
}

function formatParse(ms: number | null): string {
  if (ms == null) return "—";
  if (ms >= 1000) return `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)}s`;
  return `${Math.round(ms)}ms`;
}

const SOURCE_LABELS: Record<keyof TenantHealthReport["sources"], string> = {
  grafanaMetrics: "Grafana metrics",
  grafanaAlerts: "Grafana alerts",
  jira: "JIRA",
  loki: "Loki",
};

export function TenantHealthDashboard() {
  const [report, setReport] = useState<TenantHealthReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = (await fetch(
        `/api/tenant/report?tenant=${encodeURIComponent(TENANT)}`,
      ).then((r) => r.json())) as ReportResponse;
      setReport(data.report);
      setError(data.error ?? null);
    } catch (e) {
      setReport(null);
      setError(e instanceof Error ? e.message : "Failed to load report");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const sortedAlerts = useMemo(
    () =>
      [...(report?.alerts ?? [])].sort(
        (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity],
      ),
    [report],
  );

  const sortedIntegrations = useMemo(
    () =>
      [...(report?.integrations ?? [])].sort((a, b) => {
        const s = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
        return s !== 0 ? s : b.extractions - a.extractions;
      }),
    [report],
  );

  const partialSources = useMemo(() => {
    if (!report) return [];
    return (Object.keys(report.sources) as (keyof TenantHealthReport["sources"])[])
      .filter((k) => !report.sources[k])
      .map((k) => SOURCE_LABELS[k]);
  }, [report]);

  return (
    <div className="flex-1 overflow-auto scroll-thin">
      <header className="px-6 h-14 border-b border-border flex items-center justify-between sticky top-0 z-10 bg-bg/90 backdrop-blur">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold flex items-center gap-2">
            <HeartPulse className="h-4 w-4 text-accent" />
            Tenant Health
          </h1>
          <p className="text-[11px] text-fg-subtle">
            {report ? report.displayName : "BCG"}{" "}
            <span className="font-mono text-fg-muted">· {report?.tenant ?? TENANT}</span>
            {partialSources.length > 0 && (
              <span className="ml-2 inline-flex items-center gap-1 text-warning">
                <TriangleAlert className="h-3 w-3" />
                partial data: {partialSources.join(", ")}
              </span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {report && (
            <span className="text-[11px] text-fg-subtle text-right">
              Generated {new Date(report.generatedAt).toLocaleString()}
              <span className="text-fg-muted"> · last {report.windowHours}h</span>
            </span>
          )}
          <button
            type="button"
            onClick={refresh}
            disabled={loading}
            className="inline-flex items-center gap-1.5 rounded border border-border bg-bg-card px-2.5 py-1.5 text-xs font-medium text-fg hover:bg-bg-muted/60 transition-colors disabled:opacity-60"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
            Refresh
          </button>
        </div>
      </header>

      {loading && !report ? (
        <LoadingState />
      ) : !report ? (
        <ErrorState error={error} onRefresh={refresh} loading={loading} />
      ) : (
        <div className="p-6 space-y-6">
          {/* 2. Health header strip */}
          <Card>
            <CardBody className="flex flex-col gap-4 sm:flex-row sm:items-start sm:gap-6">
              <div className="flex items-center gap-3 shrink-0">
                <div>
                  <div className="flex items-baseline gap-1">
                    <span
                      className={cn(
                        "text-4xl font-bold tabular-nums",
                        healthTone(report.healthScore) === "green"
                          ? "text-success"
                          : healthTone(report.healthScore) === "yellow"
                            ? "text-warning"
                            : "text-danger",
                      )}
                    >
                      {report.healthScore}
                    </span>
                    <span className="text-sm text-fg-subtle">/100</span>
                  </div>
                  <div className="mt-1">
                    <HealthBadge health={healthTone(report.healthScore)} />
                  </div>
                </div>
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-[11px] uppercase tracking-wide text-fg-subtle mb-1.5">
                  Top issues
                </div>
                {report.topIssues.length === 0 ? (
                  <p className="text-sm text-fg-muted">No issues flagged.</p>
                ) : (
                  <ul className="space-y-1">
                    {report.topIssues.map((issue, i) => (
                      <li key={i} className="flex items-start gap-1.5 text-sm text-fg-muted">
                        <AlertTriangle className="h-3.5 w-3.5 text-warning mt-0.5 shrink-0" />
                        <span>{issue}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </CardBody>
          </Card>

          {/* 3. Summary stat tiles */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Stat
              icon={<Boxes className="h-4 w-4 text-accent" />}
              label="Integrations"
              value={report.totals.integrations}
            />
            <Stat
              icon={<Network className="h-4 w-4" />}
              label="Extractions"
              hint={`last ${report.windowHours}h`}
              value={report.totals.extractions}
            />
            <Stat
              icon={<AlertTriangle className="h-4 w-4 text-danger" />}
              label="Extraction errors"
              value={report.totals.extractionErrors}
              tone={report.totals.extractionErrors > 0 ? "danger" : undefined}
            />
            <Stat
              icon={<PlugZap className="h-4 w-4 text-warning" />}
              label="Active alerts"
              value={report.totals.activeAlerts}
              tone={report.totals.activeAlerts > 0 ? "warning" : undefined}
            />
          </div>

          {/* 4. Active alerts */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <PlugZap className="h-4 w-4 text-warning" /> Active alerts
              </CardTitle>
              <Badge>{sortedAlerts.length}</Badge>
            </CardHeader>
            <CardBody className="space-y-1.5">
              {sortedAlerts.length === 0 ? (
                <p className="text-sm text-fg-muted">No active alerts.</p>
              ) : (
                sortedAlerts.map((alert, i) => <AlertRow key={i} alert={alert} />)
              )}
            </CardBody>
          </Card>

          {/* 5. Integrations table */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Boxes className="h-4 w-4 text-accent" /> Integrations
              </CardTitle>
              <span className="text-[11px] text-fg-subtle">
                {sortedIntegrations.length} · by severity · last {report.windowHours}h
              </span>
            </CardHeader>
            <CardBody className="px-0 py-0">
              {sortedIntegrations.length === 0 ? (
                <p className="text-sm text-fg-muted px-4 py-6 text-center">
                  No integrations reported.
                </p>
              ) : (
                <div className="max-h-[28rem] overflow-auto scroll-thin">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-bg-card z-10">
                      <tr className="border-b border-border text-[11px] uppercase tracking-wide text-fg-subtle">
                        <th className="text-left font-medium px-4 py-2">Integration</th>
                        <th className="text-right font-medium px-3 py-2">Extractions</th>
                        <th className="text-right font-medium px-3 py-2">Errors</th>
                        <th className="text-right font-medium px-3 py-2">Parse avg</th>
                        <th className="text-right font-medium px-3 py-2">Parse tasks</th>
                        <th className="text-right font-medium px-3 py-2">Alerts</th>
                        <th className="text-left font-medium px-4 py-2">Severity</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sortedIntegrations.map((it) => (
                        <IntegrationRow key={it.integration} it={it} />
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardBody>
          </Card>

          {/* 6 + 7 side by side */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 items-start">
            {/* 6. Graph writes */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Network className="h-4 w-4 text-accent" /> Graph writes (last{" "}
                  {report.windowHours}h)
                </CardTitle>
              </CardHeader>
              <CardBody className="space-y-1.5">
                {report.graphWrites.length === 0 ? (
                  <p className="text-sm text-fg-muted">No graph writes in window.</p>
                ) : (
                  report.graphWrites.map((w, i) => <GraphWriteRow key={i} write={w} />)
                )}
                <p className="pt-1 text-[11px] text-fg-subtle">
                  write volume, not absolute graph size
                </p>
              </CardBody>
            </Card>

            {/* 7. Known vs unknown errors */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4 text-warning" /> Error classification
                </CardTitle>
              </CardHeader>
              <CardBody>
                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded border border-border bg-bg-muted/30 px-4 py-3">
                    <div className="text-[11px] uppercase tracking-wide text-fg-muted">Known</div>
                    <div className="mt-1.5 text-2xl font-semibold text-fg">
                      {report.errorClassification.known.toLocaleString()}
                    </div>
                  </div>
                  <div className="rounded border border-border bg-bg-muted/30 px-4 py-3">
                    <div className="text-[11px] uppercase tracking-wide text-fg-muted">Unknown</div>
                    <div className="mt-1.5 text-2xl font-semibold text-warning">
                      {report.errorClassification.unknown.toLocaleString()}
                    </div>
                  </div>
                </div>
              </CardBody>
            </Card>
          </div>

          {/* 8. Linked JIRA tickets */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Ticket className="h-4 w-4 text-accent" /> Linked JIRA tickets
              </CardTitle>
              <Badge>{report.jiraTickets.length}</Badge>
            </CardHeader>
            <CardBody className="space-y-1.5">
              {report.jiraTickets.length === 0 ? (
                <p className="text-sm text-fg-muted">No linked JIRA tickets.</p>
              ) : (
                report.jiraTickets.map((t) => <JiraTicketRow key={t.key} ticket={t} />)
              )}
            </CardBody>
          </Card>
        </div>
      )}
    </div>
  );
}

function AlertRow({ alert }: { alert: TenantAlert }) {
  return (
    <div className="flex items-center gap-2 rounded border border-border bg-bg-muted/30 px-3 py-2">
      <Badge className={cn("border shrink-0", severityBadgeClass(alert.severity))}>
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-current" />
        {alert.severity}
      </Badge>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-sm font-medium text-fg truncate">{alert.name}</span>
          {alert.integration && (
            <span className="text-[11px] font-mono text-fg-subtle">· {alert.integration}</span>
          )}
        </div>
        {alert.reason && <p className="mt-0.5 text-[11px] text-fg-muted">{alert.reason}</p>}
      </div>
      <Badge className="shrink-0">{alert.state}</Badge>
    </div>
  );
}

function IntegrationRow({ it }: { it: IntegrationHealth }) {
  return (
    <tr className="border-b border-border/60 last:border-0 hover:bg-bg-muted/30 transition-colors">
      <td className="px-4 py-1.5 font-medium text-fg">{it.integration}</td>
      <td className="px-3 py-1.5 text-right font-mono text-fg-muted">
        {it.extractions.toLocaleString()}
      </td>
      <td
        className={cn(
          "px-3 py-1.5 text-right font-mono",
          it.extractionErrors > 0 ? "text-danger" : "text-fg-subtle",
        )}
      >
        {it.extractionErrors.toLocaleString()}
      </td>
      <td className="px-3 py-1.5 text-right font-mono text-fg-muted">
        {formatParse(it.parseAvgMs)}
      </td>
      <td className="px-3 py-1.5 text-right font-mono text-fg-muted">
        {it.parseTasks.toLocaleString()}
      </td>
      <td className="px-3 py-1.5 text-right">
        {it.alerts.length > 0 ? (
          <Badge className="border-warning/40 bg-warning/10 text-warning border font-mono">
            {it.alerts.length}
          </Badge>
        ) : (
          <span className="font-mono text-fg-subtle">0</span>
        )}
      </td>
      <td className="px-4 py-1.5">
        <Badge className={cn("border", severityBadgeClass(it.severity))}>
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-current" />
          {it.severity}
        </Badge>
      </td>
    </tr>
  );
}

function GraphWriteRow({ write }: { write: GraphWrite }) {
  return (
    <div className="flex items-center justify-between gap-2 text-sm">
      <span className="text-fg-muted">
        <span className="font-medium text-fg">{write.entityType}</span>
        <span className="text-fg-subtle"> / {write.operation}</span>
      </span>
      <span className="font-mono text-fg">{write.count.toLocaleString()}</span>
    </div>
  );
}

function JiraTicketRow({ ticket }: { ticket: TenantJiraTicket }) {
  return (
    <div className="flex items-center gap-2 rounded border border-border bg-bg-muted/30 px-3 py-2">
      <a
        href={ticket.url}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-1 text-xs font-mono font-semibold text-accent hover:text-accent-hover shrink-0"
      >
        {ticket.key}
        <ExternalLink className="h-3 w-3" />
      </a>
      <span className="text-sm text-fg-muted truncate flex-1">{ticket.summary}</span>
      <StatusChip status={ticket.status} />
    </div>
  );
}

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
      <div className={`mt-1.5 text-2xl font-semibold ${toneCls}`}>
        {value.toLocaleString()}
      </div>
      {hint && <div className="mt-0.5 text-[10px] text-fg-subtle">{hint}</div>}
    </div>
  );
}

function LoadingState() {
  return (
    <div className="flex-1 flex items-center justify-center p-12">
      <div className="flex flex-col items-center gap-3 text-fg-muted">
        <RefreshCw className="h-6 w-6 animate-spin text-accent" />
        <p className="text-sm">Loading tenant health…</p>
      </div>
    </div>
  );
}

function ErrorState({
  error,
  onRefresh,
  loading,
}: {
  error: string | null;
  onRefresh: () => void;
  loading: boolean;
}) {
  return (
    <div className="flex-1 flex items-center justify-center p-12">
      <div className="max-w-md text-center space-y-3">
        <div className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-warning/15 border border-warning/30">
          <Inbox className="h-5 w-5 text-warning" />
        </div>
        <h2 className="text-lg font-semibold">No tenant health report</h2>
        <p className="text-sm text-fg-muted">
          {error
            ? `Couldn't load the report: ${error}`
            : "No report is available for this tenant yet. Try refreshing once the sync has run."}
        </p>
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          className="inline-flex items-center gap-1.5 rounded border border-border bg-bg-card px-3 py-1.5 text-xs font-medium text-fg hover:bg-bg-muted/60 transition-colors disabled:opacity-60"
        >
          <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
          Refresh
        </button>
      </div>
    </div>
  );
}
