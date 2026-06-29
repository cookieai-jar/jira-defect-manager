"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge, HealthBadge } from "@/components/ui/badge";
import { StatusChip } from "@/components/jira-chips";
import { cn } from "@/lib/utils";
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  Boxes,
  ChevronRight,
  Clock,
  Database,
  ExternalLink,
  Flag,
  HeartPulse,
  Inbox,
  Network,
  PlugZap,
  RefreshCw,
  ScrollText,
  Server,
  Sparkles,
  Stethoscope,
  Ticket,
  TriangleAlert,
} from "lucide-react";
import type {
  ErrorReason,
  ErrorRcaResult,
  ErrorTimelinePoint,
  GraphWrite,
  IntegrationErrorSignals,
  IntegrationHealth,
  IntegrationState,
  Severity,
  TenantAlert,
  TenantConfigInfo,
  TenantFeatureFlags,
  TenantHealthReport,
  TenantJiraTicket,
} from "@/types/tenant";
import { groupTicketsByProject, type ProjectTicketGroup } from "@/lib/tenant-jira";
import { signalsFingerprint } from "@/lib/rca-core";
import { Sparkline } from "@/components/sparkline";

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

/** Tone for the integration success/fail state badge (see IntegrationState semantics). */
function stateBadgeClass(state: IntegrationState): string {
  if (state === "failing") return "border-danger/40 bg-danger/10 text-danger";
  if (state === "stalled") return "border-warning/40 bg-warning/10 text-warning";
  if (state === "ok") return "border-success/40 bg-success/10 text-success";
  // idle
  return "border-fg-subtle/40 bg-fg-subtle/10 text-fg-subtle";
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

/** Compact human age from a seconds value: "Ns" / "Nm" / "Nh" / "Nd". */
function formatAge(sec: number | null): string {
  if (sec == null) return "—";
  if (sec < 60) return `${Math.round(sec)}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  if (sec < 86_400) return `${Math.round(sec / 3600)}h`;
  return `${Math.round(sec / 86_400)}d`;
}

/** Tone for an age value: warning past 24h, danger past 72h, else muted. */
function ageTone(sec: number | null): "muted" | "warning" | "danger" {
  if (sec == null) return "muted";
  if (sec > 72 * 3600) return "danger";
  if (sec > 24 * 3600) return "warning";
  return "muted";
}

function ageToneClass(sec: number | null): string {
  const t = ageTone(sec);
  if (t === "danger") return "text-danger";
  if (t === "warning") return "text-warning";
  return "text-fg-subtle";
}

/** Tone for an error-reason class badge: user=warning, internal=danger, unknown=muted. */
function errorClassBadgeClass(errorClass: ErrorReason["errorClass"]): string {
  if (errorClass === "internal") return "border-danger/40 bg-danger/10 text-danger";
  if (errorClass === "user") return "border-warning/40 bg-warning/10 text-warning";
  return "border-fg-subtle/40 bg-fg-subtle/10 text-fg-muted";
}

/** Human label for an error class — "internal" reads as "product" (Veza-side) to users. */
function classLabel(errorClass: ErrorReason["errorClass"]): string {
  if (errorClass === "internal") return "product";
  return errorClass; // "user" | "unknown"
}

const SOURCE_LABELS: Record<keyof TenantHealthReport["sources"], string> = {
  grafanaMetrics: "Grafana metrics",
  grafanaAlerts: "Grafana alerts",
  jira: "JIRA",
  loki: "Loki",
};

/** Integrations worth a root-cause analysis — anything that isn't clean. */
function isAnalyzable(it: IntegrationHealth): boolean {
  return (
    it.state === "failing" ||
    it.state === "stalled" ||
    it.failing > 0 ||
    it.extractionErrors > 0 ||
    it.severity !== "ok"
  );
}

function toSignals(it: IntegrationHealth): IntegrationErrorSignals {
  return {
    integration: it.integration,
    state: it.state,
    severity: it.severity,
    failing: it.failing,
    extractionErrors: it.extractionErrors,
    freshnessSec: it.freshnessSec,
    lagSec: it.lagSec,
    topReasons: it.topReasons,
    topErrors: it.topErrors,
  };
}

export function TenantHealthDashboard({ tenant }: { tenant: string }) {
  const [report, setReport] = useState<TenantHealthReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Deep error analysis (RCA) state — keyed by integration name.
  const [rca, setRca] = useState<Map<string, ErrorRcaResult>>(new Map());
  const [rcaLoading, setRcaLoading] = useState<Set<string>>(new Set());
  const [rcaProgress, setRcaProgress] = useState<{ done: number; total: number } | null>(null);
  const analyzingAllRef = useRef(false);

  const analyzeOne = useCallback(
    async (it: IntegrationHealth): Promise<void> => {
      setRcaLoading((s) => new Set(s).add(it.integration));
      try {
        const data = (await fetch("/api/tenant/error-analysis", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tenant, signals: toSignals(it) }),
        }).then((r) => r.json())) as { result: ErrorRcaResult | null; error?: string };
        const result: ErrorRcaResult =
          data.result ??
          {
            integration: it.integration,
            headline: "Analysis failed",
            ownership: "unknown",
            rootCause: data.error ?? "The analyzer returned no result.",
            evidence: [],
            fix: [],
            confidence: "low",
            sampleCount: 0,
            generatedAt: new Date().toISOString(),
            signalsFingerprint: signalsFingerprint(toSignals(it)),
            error: data.error ?? "no result",
          };
        setRca((m) => new Map(m).set(it.integration, result));
      } catch (e) {
        setRca((m) =>
          new Map(m).set(it.integration, {
            integration: it.integration,
            headline: "Analysis failed",
            ownership: "unknown",
            rootCause: e instanceof Error ? e.message : "Request failed.",
            evidence: [],
            fix: [],
            confidence: "low",
            sampleCount: 0,
            generatedAt: new Date().toISOString(),
            signalsFingerprint: signalsFingerprint(toSignals(it)),
            error: "request failed",
          }),
        );
      } finally {
        setRcaLoading((s) => {
          const next = new Set(s);
          next.delete(it.integration);
          return next;
        });
      }
    },
    [tenant],
  );

  const analyzeAll = useCallback(async () => {
    if (analyzingAllRef.current) return; // ignore re-entry while a run is in flight
    const targets = (report?.integrations ?? []).filter(isAnalyzable);
    if (targets.length === 0) return;
    if (targets.length > 15 && !window.confirm(`Run deep analysis on ${targets.length} integrations? That's ${targets.length} Claude calls.`)) {
      return;
    }
    analyzingAllRef.current = true;
    setRcaProgress({ done: 0, total: targets.length });
    // Bounded concurrency (3 in flight) so results stream in without hammering the API.
    let next = 0;
    let done = 0;
    const PARALLEL = 3;
    const worker = async () => {
      while (next < targets.length) {
        const it = targets[next++];
        await analyzeOne(it);
        done++;
        setRcaProgress({ done, total: targets.length });
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(PARALLEL, targets.length) }, worker));
    } finally {
      setRcaProgress(null);
      analyzingAllRef.current = false;
    }
  }, [report, analyzeOne]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = (await fetch(
        `/api/tenant/report?tenant=${encodeURIComponent(tenant)}`,
      ).then((r) => r.json())) as ReportResponse;
      setReport(data.report);
      setError(data.error ?? null);
    } catch (e) {
      setReport(null);
      setError(e instanceof Error ? e.message : "Failed to load report");
    } finally {
      setLoading(false);
    }
  }, [tenant]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Seed persisted RCAs for this tenant so prior analyses survive refresh/navigation.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = (await fetch(
          `/api/tenant/error-analysis?tenant=${encodeURIComponent(tenant)}`,
        ).then((r) => r.json())) as { results?: ErrorRcaResult[] };
        if (!cancelled && data.results?.length) {
          // Merge with local state preferring any analysis already run this session
          // (avoids a slow seed clobbering a just-completed result).
          setRca((prev) => {
            const merged = new Map(data.results!.map((r) => [r.integration, r]));
            for (const [k, v] of prev) merged.set(k, v);
            return merged;
          });
        }
      } catch {
        /* persisted RCAs are best-effort */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tenant]);

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
        return s !== 0 ? s : (b.providers ?? 0) - (a.providers ?? 0);
      }),
    [report],
  );

  const liveActivity = useMemo(() => {
    const integrations = report?.integrations ?? [];
    return {
      extracting: integrations.filter((it) => it.extractingNow).map((it) => it.integration),
      parsing: integrations.filter((it) => it.parsingNow).map((it) => it.integration),
    };
  }, [report]);

  // Current signal fingerprint per integration — compared to each stored RCA's
  // fingerprint to flag it fresh vs stale (the failure picture changed since).
  const currentFingerprints = useMemo(() => {
    const m = new Map<string, string>();
    for (const it of report?.integrations ?? []) m.set(it.integration, signalsFingerprint(toSignals(it)));
    return m;
  }, [report]);

  const ticketGroups = useMemo(
    () => groupTicketsByProject(report?.jiraTickets ?? []),
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
            <Link
              href="/tenants"
              className="inline-flex items-center gap-1 text-xs font-normal text-fg-muted hover:text-accent transition-colors"
            >
              <ArrowLeft className="h-3 w-3" />
              All tenants
            </Link>
          </h1>
          <p className="text-[11px] text-fg-subtle">
            {report ? report.displayName : tenant}{" "}
            <span className="font-mono text-fg-muted">· {report?.tenant ?? tenant}</span>
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
          {report?.healthDashboardUrl && (
            <a
              href={report.healthDashboardUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 rounded border border-border bg-bg-card px-2.5 py-1.5 text-xs font-medium text-fg-muted hover:text-accent hover:bg-bg-muted/60 transition-colors"
              title="Open the tenant health dashboard in Grafana"
            >
              Grafana
              <ExternalLink className="h-3 w-3" />
            </a>
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
              <div
                className="flex items-center gap-3 shrink-0"
                title="Health score (higher = healthier): 100 × (1 − share of integrations failing/degraded), minus a capped penalty for firing infra alerts."
              >
                <div>
                  <div className="text-[11px] uppercase tracking-wide text-fg-subtle">Health score</div>
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
              <HealthTrendBlock history={report.healthHistory} current={report.healthScore} />
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
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
            <Stat
              icon={<Boxes className="h-4 w-4 text-accent" />}
              label="Integrations"
              value={report.totals.integrations}
            />
            <Stat
              icon={<Network className="h-4 w-4" />}
              label="Providers"
              hint="actively extracting"
              value={report.totals.providers ?? 0}
            />
            <Stat
              icon={<Database className="h-4 w-4 text-accent" />}
              label="Datasources"
              hint="resources across tenant"
              value={report.totals.datasources}
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
            <Stat
              icon={<Inbox className="h-4 w-4 text-warning" />}
              label="Extract backlog"
              hint="jobs pending in queue"
              value={report.totals.pendingExtractJobs}
              tone={report.totals.pendingExtractJobs > 0 ? "warning" : undefined}
            />
          </div>

          {/* 3a. Error classification — who fixes it (the key triage axis) */}
          <ErrorClassCard errorClass={report.errorClass} errorLogsUrl={report.errorLogsUrl} />

          {/* 3a-ii. Top error reasons — what's failing & who owns it */}
          <TopErrorReasonsCard reasons={report.topErrorReasons} errorLogsUrl={report.errorLogsUrl} />

          {/* 3b. Live activity — what's running right now */}
          <LiveActivityCard
            extracting={liveActivity.extracting}
            parsing={liveActivity.parsing}
          />

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
            <CardHeader className="flex flex-row items-center justify-between gap-2">
              <div className="flex items-baseline gap-2">
                <CardTitle className="flex items-center gap-2">
                  <Boxes className="h-4 w-4 text-accent" /> Integrations
                </CardTitle>
                <span className="text-[11px] text-fg-subtle">
                  {sortedIntegrations.length} · by severity · last {report.windowHours}h
                </span>
              </div>
              {(() => {
                const targets = sortedIntegrations.filter(isAnalyzable);
                const running = rcaProgress !== null;
                if (targets.length === 0) return null;
                return (
                  <button
                    type="button"
                    onClick={analyzeAll}
                    disabled={running}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded border px-2.5 py-1 text-xs font-medium transition-colors",
                      running
                        ? "border-border bg-bg-muted text-fg-subtle cursor-wait"
                        : "border-accent/40 bg-accent/10 text-accent hover:bg-accent/20",
                    )}
                    title="Run deep root-cause analysis on every failing integration"
                  >
                    <Sparkles className={cn("h-3.5 w-3.5", running && "animate-pulse")} />
                    {running
                      ? `Analyzing ${rcaProgress!.done}/${rcaProgress!.total}…`
                      : `Analyze failing (${targets.length})`}
                  </button>
                );
              })()}
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
                        <th className="text-left font-medium px-3 py-2">State</th>
                        <th className="text-right font-medium px-3 py-2">Providers</th>
                        <th className="text-right font-medium px-3 py-2" title="Outdated datasources">Lag</th>
                        <th className="text-right font-medium px-3 py-2" title="Datasources currently failing extraction">Failing</th>
                        <th className="text-right font-medium px-3 py-2" title="Time since last successful parse">Freshness</th>
                        <th className="text-right font-medium px-3 py-2" title="Oldest pending extract job">Pending</th>
                        <th className="text-right font-medium px-3 py-2">Errors</th>
                        <th className="text-right font-medium px-3 py-2">Parse avg</th>
                        <th className="text-right font-medium px-3 py-2">Parse tasks</th>
                        <th className="text-right font-medium px-3 py-2">Alerts</th>
                        <th className="text-left font-medium px-4 py-2">Severity</th>
                        <th className="w-8 px-2 py-2" aria-label="Links" />
                      </tr>
                    </thead>
                    <tbody>
                      {sortedIntegrations.map((it) => (
                        <IntegrationRow
                          key={it.integration}
                          it={it}
                          canAnalyze={isAnalyzable(it)}
                          analyzing={rcaLoading.has(it.integration)}
                          analyzed={rca.has(it.integration)}
                          disabled={rcaProgress !== null}
                          onAnalyze={() => analyzeOne(it)}
                        />
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardBody>
          </Card>

          {/* 5a-ii. Root-cause analysis results */}
          {rca.size > 0 && (
            <RcaResultsCard
              results={(() => {
                // Show analyzed integrations in the table's order, then any whose
                // integration is no longer present in the report (still useful history).
                const inOrder = sortedIntegrations
                  .map((it) => rca.get(it.integration))
                  .filter((r): r is ErrorRcaResult => Boolean(r));
                const shown = new Set(inOrder.map((r) => r.integration));
                const orphans = [...rca.values()].filter((r) => !shown.has(r.integration));
                return [...inOrder, ...orphans];
              })()}
              currentFingerprints={currentFingerprints}
              onDismiss={() => {
                setRca(new Map());
                setRcaProgress(null);
                fetch(`/api/tenant/error-analysis?tenant=${encodeURIComponent(tenant)}`, {
                  method: "DELETE",
                }).catch(() => {});
              }}
            />
          )}

          {/* 5b. Extraction errors over time */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Activity className="h-4 w-4 text-accent" /> Extraction errors over time
              </CardTitle>
              <span className="text-[11px] text-fg-subtle">last {report.windowHours}h</span>
            </CardHeader>
            <CardBody>
              <ErrorTimeline points={report.errorTimeline} />
            </CardBody>
          </Card>

          {/* 6 / 6b / 7: graph writes + error classification stacked left, graph size spanning right */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 items-stretch">
            {/* left column: graph writes (throughput) stacked over error classification */}
            <div className="flex flex-col gap-3">
              {/* 6. Graph writes — throughput */}
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Network className="h-4 w-4 text-accent" /> Graph writes (last{" "}
                    {report.windowHours}h)
                  </CardTitle>
                  <span className="text-[11px] text-fg-subtle">throughput</span>
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

              {/* 7. Known vs unknown alerts (alert taxonomy, distinct from the metric class split above) */}
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <AlertTriangle className="h-4 w-4 text-warning" /> Known vs unknown alerts
                  </CardTitle>
                  <span className="text-[11px] text-fg-subtle">recognized vs unclassified firing alerts</span>
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

            {/* 6b. Graph size — totals (spans the height of both left cards) */}
            <GraphSizeCard graphSize={report.graphSize} />
          </div>

          {/* 7b + 7c side by side: tenant config + dynamic feature flags */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 items-start">
            <TenantConfigCard config={report.config} />
            <FeatureFlagsCard featureFlags={report.featureFlags} />
          </div>

          {/* 8. Linked JIRA tickets — by project, priority-sorted, Done collapsed */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Ticket className="h-4 w-4 text-accent" /> Linked JIRA tickets
              </CardTitle>
              <Badge>{report.jiraTickets.length}</Badge>
            </CardHeader>
            <CardBody className="space-y-4">
              {report.jiraTickets.length === 0 ? (
                <p className="text-sm text-fg-muted">No linked JIRA tickets.</p>
              ) : (
                ticketGroups.map((g) => <ProjectTicketSection key={g.project} group={g} />)
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

function LiveActivityCard({
  extracting,
  parsing,
}: {
  extracting: string[];
  parsing: string[];
}) {
  const idle = extracting.length === 0 && parsing.length === 0;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-accent" /> Live activity
        </CardTitle>
        <span className="text-[11px] text-fg-subtle">running right now</span>
      </CardHeader>
      <CardBody className="space-y-3">
        {idle ? (
          <p className="text-sm text-fg-muted">Nothing extracting or parsing right now.</p>
        ) : (
          <>
            <LiveActivityGroup
              dotClass="bg-success"
              labelClass="text-success"
              count={extracting.length}
              noun="extracting"
              names={extracting}
            />
            <LiveActivityGroup
              dotClass="bg-accent"
              labelClass="text-accent"
              count={parsing.length}
              noun="parsing"
              names={parsing}
            />
          </>
        )}
      </CardBody>
    </Card>
  );
}

function LiveActivityGroup({
  dotClass,
  labelClass,
  count,
  noun,
  names,
}: {
  dotClass: string;
  labelClass: string;
  count: number;
  noun: string;
  names: string[];
}) {
  if (count === 0) return null;
  return (
    <div className="space-y-1.5">
      <div className={cn("flex items-center gap-1.5 text-sm font-medium", labelClass)}>
        <span className={cn("inline-block h-2 w-2 rounded-full animate-pulse", dotClass)} />
        {count.toLocaleString()} {count === 1 ? "integration" : "integrations"} {noun}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {names.map((name) => (
          <Badge key={name} className="border border-border-strong bg-bg-muted text-fg-muted">
            {name}
          </Badge>
        ))}
      </div>
    </div>
  );
}

function IntegrationRow({
  it,
  canAnalyze,
  analyzing,
  analyzed,
  disabled,
  onAnalyze,
}: {
  it: IntegrationHealth;
  canAnalyze: boolean;
  analyzing: boolean;
  analyzed: boolean;
  disabled: boolean;
  onAnalyze: () => void;
}) {
  const topReasons = (it.topReasons ?? []).slice(0, 2);
  const topErrors = it.topErrors.slice(0, 2);
  return (
    <tr className="border-b border-border/60 last:border-0 hover:bg-bg-muted/30 transition-colors align-top">
      <td className="px-4 py-1.5 font-medium text-fg">
        <div>{it.integration}</div>
        {topReasons.length > 0 ? (
          <div className="mt-0.5 space-y-0.5">
            {topReasons.map((r, i) => (
              <div
                key={i}
                className="max-w-[24rem] truncate text-[11px] font-normal"
                title={`${r.reason} (${r.errorClass}) ×${r.count.toLocaleString()}`}
              >
                <span className="font-mono text-fg-muted">{r.reason}</span>{" "}
                <span
                  className={cn(
                    "font-medium",
                    r.errorClass === "internal"
                      ? "text-danger"
                      : r.errorClass === "user"
                        ? "text-warning"
                        : "text-fg-subtle",
                  )}
                >
                  ({r.errorClass})
                </span>{" "}
                <span className="text-fg-subtle">×{r.count.toLocaleString()}</span>
              </div>
            ))}
          </div>
        ) : (
          topErrors.length > 0 && (
            <div className="mt-0.5 space-y-0.5">
              {topErrors.map((e, i) => (
                <div
                  key={i}
                  className="max-w-[22rem] truncate text-[11px] font-normal text-danger/80"
                  title={`${e.signature} ×${e.count.toLocaleString()}`}
                >
                  {e.signature} <span className="text-fg-subtle">×{e.count.toLocaleString()}</span>
                </div>
              ))}
            </div>
          )
        )}
      </td>
      <td className="px-3 py-1.5">
        <div className="flex flex-col items-start gap-1">
          <Badge className={cn("border", stateBadgeClass(it.state))}>
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-current" />
            {it.state}
          </Badge>
          {(it.extractingNow || it.parsingNow) && (
            <div className="flex items-center gap-2 text-[10px] font-medium">
              {it.extractingNow && (
                <span className="inline-flex items-center gap-1 text-success" title="Extracting now">
                  <span className="inline-block h-1.5 w-1.5 rounded-full bg-success animate-pulse" />
                  extracting
                </span>
              )}
              {it.parsingNow && (
                <span className="inline-flex items-center gap-1 text-accent" title="Parsing now">
                  <span className="inline-block h-1.5 w-1.5 rounded-full bg-accent animate-pulse" />
                  parsing
                </span>
              )}
            </div>
          )}
        </div>
      </td>
      <td className="px-3 py-1.5 text-right font-mono text-fg-muted">
        {it.providers == null ? "—" : it.providers.toLocaleString()}
      </td>
      <td className="px-3 py-1.5 text-right">
        {it.outdated > 0 ? (
          <span
            className="inline-flex items-center gap-1 font-mono text-warning"
            title={`${it.outdated.toLocaleString()} outdated datasource(s)`}
          >
            <Clock className="h-3 w-3" />
            {it.outdated.toLocaleString()}
          </span>
        ) : (
          <span className="font-mono text-fg-subtle">0</span>
        )}
      </td>
      <td className="px-3 py-1.5 text-right">
        {it.failing > 0 ? (
          <span
            className="inline-flex items-center gap-1 font-mono text-danger"
            title={`${it.failing.toLocaleString()} datasource(s) currently failing extraction`}
          >
            <TriangleAlert className="h-3 w-3" />
            {it.failing.toLocaleString()}
          </span>
        ) : (
          <span className="font-mono text-fg-subtle">0</span>
        )}
      </td>
      <td
        className={cn("px-3 py-1.5 text-right font-mono", ageToneClass(it.freshnessSec))}
        title={
          it.freshnessSec == null
            ? "No successful parse recorded"
            : `${formatAge(it.freshnessSec)} since last successful parse`
        }
      >
        {formatAge(it.freshnessSec)}
      </td>
      <td
        className={cn("px-3 py-1.5 text-right font-mono", ageToneClass(it.lagSec))}
        title={
          it.lagSec == null
            ? "No pending extracts"
            : `oldest pending extract: ${formatAge(it.lagSec)}`
        }
      >
        {formatAge(it.lagSec)}
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
      <td className="px-2 py-1.5 text-right">
        <div className="inline-flex items-center gap-2">
          {canAnalyze && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onAnalyze();
              }}
              disabled={analyzing || disabled}
              className={cn(
                "inline-flex transition-colors",
                analyzing
                  ? "text-accent cursor-wait"
                  : disabled
                    ? "text-fg-subtle/40 cursor-not-allowed"
                    : analyzed
                      ? "text-accent hover:text-accent-hover"
                      : "text-fg-subtle hover:text-accent",
              )}
              title={analyzed ? `Re-run RCA for ${it.integration}` : `Deep error analysis (RCA) for ${it.integration}`}
            >
              <Stethoscope className={cn("h-3.5 w-3.5", analyzing && "animate-pulse")} />
            </button>
          )}
          {it.logsUrl && (it.extractionErrors > 0 || it.failing > 0) && (
            <a
              href={it.logsUrl}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="inline-flex text-fg-subtle hover:text-accent transition-colors"
              title={`Open ${it.integration} error logs in Grafana`}
            >
              <ScrollText className="h-3.5 w-3.5" />
            </a>
          )}
          {it.connectorUrl && (
            <a
              href={it.connectorUrl}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="inline-flex text-fg-subtle hover:text-accent transition-colors"
              title="Open connector dashboard in Grafana"
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          )}
        </div>
      </td>
    </tr>
  );
}

/** Small "View logs ↗" link into Grafana Explore; renders nothing when no URL. */
function LogsLink({ href, label = "View logs", className }: { href: string | null; label?: string; className?: string }) {
  if (!href) return null;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      title="Open these error logs in Grafana Explore"
      className={cn(
        "inline-flex items-center gap-1 text-[11px] text-fg-subtle hover:text-accent transition-colors",
        className,
      )}
    >
      <ScrollText className="h-3.5 w-3.5" /> {label}
    </a>
  );
}

function HealthTrendBlock({
  history,
  current,
}: {
  history: { t: string; score: number }[];
  current: number;
}) {
  // Trend = recent snapshots + the live score, capped for sane density; delta vs
  // the oldest point SHOWN (so the number matches the line).
  const scores = [...history.map((h) => h.score), current].slice(-48);
  const delta = scores.length > 1 ? current - scores[0] : null;
  return (
    <div className="shrink-0 sm:border-l sm:border-border sm:pl-6">
      <div className="text-[11px] uppercase tracking-wide text-fg-subtle">Health over time</div>
      {scores.length < 2 ? (
        <p className="mt-2 text-xs text-fg-subtle max-w-[12rem]">
          Collecting history — a point is recorded each time the fleet view refreshes (~hourly).
        </p>
      ) : (
        <div className="mt-1.5 flex items-center gap-3">
          <Sparkline values={scores} width={120} height={32} className="text-accent" />
          <div className="text-xs">
            {delta != null && delta !== 0 ? (
              <div
                className={cn("font-mono font-semibold", delta > 0 ? "text-success" : "text-danger")}
                title="vs the earliest sample shown"
              >
                {delta > 0 ? "▲" : "▼"} {Math.abs(delta)}
              </div>
            ) : (
              <div className="font-mono text-fg-subtle">flat</div>
            )}
            <div className="text-[10px] text-fg-subtle">
              {scores.length} pts · {Math.min(...scores)}–{Math.max(...scores)}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ErrorClassCard({
  errorClass,
  errorLogsUrl,
}: {
  errorClass: TenantHealthReport["errorClass"];
  errorLogsUrl: string | null;
}) {
  const buckets = [
    { label: "User", value: errorClass.user, hint: "customer fixes", tone: "border-warning/30 bg-warning/5", num: "text-warning" },
    { label: "Product", value: errorClass.internal, hint: "Veza fixes", tone: "border-danger/30 bg-danger/5", num: "text-danger" },
    { label: "Unknown", value: errorClass.unknown, hint: "needs triage", tone: "border-fg-subtle/30 bg-fg-subtle/5", num: "text-fg-muted" },
  ];
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <div>
          <CardTitle className="flex items-center gap-2">
            <TriangleAlert className="h-4 w-4 text-warning" /> Error classification — who fixes it
          </CardTitle>
          <span className="text-[11px] text-fg-subtle">from cookie_platform_scheduling_error_reasons</span>
        </div>
        <LogsLink href={errorLogsUrl} label="View error logs" />
      </CardHeader>
      <CardBody>
        <div className="grid grid-cols-3 gap-3">
          {buckets.map((b) => (
            <div key={b.label} className={cn("rounded border px-4 py-3", b.tone)}>
              <div className="text-[11px] uppercase tracking-wide text-fg-muted">{b.label}</div>
              <div className={cn("mt-1.5 text-3xl font-bold tabular-nums", b.num)}>
                {b.value.toLocaleString()}
              </div>
              <div className="mt-0.5 text-[10px] text-fg-subtle">{b.hint}</div>
            </div>
          ))}
        </div>
        <p className="pt-2 text-[11px] text-fg-subtle">
          user = customer fixes (perms/creds/network) · product = Veza bug/infra · unknown = unclassified, needs triage
        </p>
      </CardBody>
    </Card>
  );
}

function TopErrorReasonsCard({ reasons, errorLogsUrl }: { reasons: ErrorReason[]; errorLogsUrl: string | null }) {
  const rows = reasons ?? [];
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <div>
          <CardTitle className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-danger" /> Top error reasons
          </CardTitle>
          <span className="text-[11px] text-fg-subtle">what&apos;s failing &amp; who owns it</span>
        </div>
        <LogsLink href={errorLogsUrl} label="View error logs" />
      </CardHeader>
      <CardBody className="px-0 py-0">
        {rows.length === 0 ? (
          <p className="text-sm text-fg-muted px-4 py-6 text-center">No classified error reasons.</p>
        ) : (
          <div className="max-h-[24rem] overflow-auto scroll-thin">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-bg-card z-10">
                <tr className="border-b border-border text-[11px] uppercase tracking-wide text-fg-subtle">
                  <th className="text-left font-medium px-4 py-2">Integration</th>
                  <th className="text-left font-medium px-3 py-2">Class</th>
                  <th className="text-left font-medium px-3 py-2">Reason</th>
                  <th className="text-right font-medium px-3 py-2">Count</th>
                  <th className="text-right font-medium px-4 py-2">Logs</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr
                    key={`${r.integration ?? ""}-${r.reason}-${i}`}
                    className="border-b border-border/60 last:border-0 hover:bg-bg-muted/30 transition-colors"
                  >
                    <td className="px-4 py-1.5 font-mono text-fg-muted">{r.integration ?? "—"}</td>
                    <td className="px-3 py-1.5">
                      <Badge className={cn("border", errorClassBadgeClass(r.errorClass))}>
                        {classLabel(r.errorClass)}
                      </Badge>
                    </td>
                    <td
                      className="px-3 py-1.5 font-mono text-fg max-w-[28rem] truncate"
                      title={r.reason}
                    >
                      {r.reason}
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono text-fg">
                      {r.count.toLocaleString()}
                    </td>
                    <td className="px-4 py-1.5 text-right">
                      {r.logsUrl ? (
                        <a
                          href={r.logsUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          title={`Open ${r.integration ?? "tenant"} error logs in Grafana`}
                          className="inline-flex text-fg-subtle hover:text-accent transition-colors"
                        >
                          <ScrollText className="h-3.5 w-3.5" />
                        </a>
                      ) : (
                        <span className="text-fg-subtle">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardBody>
    </Card>
  );
}

function ownershipBadgeClass(o: ErrorRcaResult["ownership"]): string {
  if (o === "product") return "border-danger/40 bg-danger/10 text-danger";
  if (o === "user") return "border-warning/40 bg-warning/10 text-warning";
  return "border-fg-subtle/40 bg-fg-subtle/10 text-fg-muted";
}

function ownershipLabel(o: ErrorRcaResult["ownership"]): string {
  if (o === "product") return "product — Veza fixes";
  if (o === "user") return "user — customer fixes";
  return "unknown — needs triage";
}

function confidenceClass(c: ErrorRcaResult["confidence"]): string {
  if (c === "high") return "text-success";
  if (c === "medium") return "text-warning";
  return "text-fg-subtle";
}

/** Relative "x ago" from an ISO timestamp. */
function formatAgo(iso: string): string {
  const sec = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  return formatAge(sec);
}

function RcaResultItem({ r, stale }: { r: ErrorRcaResult; stale: boolean }) {
  return (
    <div
      className={cn(
        "rounded border px-4 py-3",
        r.error ? "border-danger/40 bg-danger/5" : "border-border bg-bg-muted/20",
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono font-semibold text-fg">{r.integration}</span>
        <Badge className={cn("border", ownershipBadgeClass(r.ownership))}>{ownershipLabel(r.ownership)}</Badge>
        <span className={cn("text-[11px] font-medium", confidenceClass(r.confidence))}>
          {r.confidence} confidence
        </span>
        {stale ? (
          <Badge
            className="border border-warning/40 bg-warning/10 text-warning"
            title="The integration's error signals changed after this analysis — re-run for a current picture."
          >
            stale
          </Badge>
        ) : (
          <Badge className="border border-success/40 bg-success/10 text-success" title="Matches the current failure signals.">
            fresh
          </Badge>
        )}
        <span className="ml-auto text-[10px] text-fg-subtle" title={new Date(r.generatedAt).toLocaleString()}>
          {r.sampleCount} log sample{r.sampleCount === 1 ? "" : "s"} · analyzed {formatAgo(r.generatedAt)} ago
        </span>
      </div>
      <p className="mt-2 text-sm font-medium text-fg">{r.headline}</p>
      <p className="mt-1 text-sm text-fg-muted">{r.rootCause}</p>
      {r.evidence.length > 0 && (
        <div className="mt-2">
          <div className="text-[10px] uppercase tracking-wide text-fg-subtle">Evidence</div>
          <ul className="mt-0.5 space-y-0.5">
            {r.evidence.map((e, i) => (
              <li key={i} className="font-mono text-[11px] text-fg-muted break-words">
                · {e}
              </li>
            ))}
          </ul>
        </div>
      )}
      {r.fix.length > 0 && (
        <div className="mt-2">
          <div className="text-[10px] uppercase tracking-wide text-fg-subtle">Suggested fix</div>
          <ol className="mt-0.5 list-decimal pl-5 space-y-0.5">
            {r.fix.map((f, i) => (
              <li key={i} className="text-sm text-fg">
                {f}
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

function RcaResultsCard({
  results,
  currentFingerprints,
  onDismiss,
}: {
  results: ErrorRcaResult[];
  currentFingerprints: Map<string, string>;
  onDismiss: () => void;
}) {
  // Stale = the integration's live fingerprint differs from the analyzed one, or
  // the integration is no longer in the report (can't confirm it still matches).
  const isStale = (r: ErrorRcaResult): boolean => {
    const cur = currentFingerprints.get(r.integration);
    return cur === undefined || cur !== r.signalsFingerprint;
  };
  const staleCount = results.filter(isStale).length;
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <div>
          <CardTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-accent" /> Root-cause analysis
          </CardTitle>
          <span className="text-[11px] text-fg-subtle">
            AI-generated from error logs + metrics — verify before acting
            {staleCount > 0 && ` · ${staleCount} stale (signals changed — re-run)`}
          </span>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="text-[11px] text-fg-subtle hover:text-accent transition-colors"
        >
          Clear
        </button>
      </CardHeader>
      <CardBody className="space-y-3">
        {results.map((r) => (
          <RcaResultItem key={r.integration} r={r} stale={isStale(r)} />
        ))}
      </CardBody>
    </Card>
  );
}

function GraphSizeCard({
  graphSize,
}: {
  graphSize: TenantHealthReport["graphSize"];
}) {
  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Network className="h-4 w-4 text-accent" /> Graph size
        </CardTitle>
        <span className="text-[11px] text-fg-subtle">totals</span>
      </CardHeader>
      <CardBody className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded border border-border bg-bg-muted/30 px-4 py-3">
            <div className="text-[11px] uppercase tracking-wide text-fg-muted">Nodes</div>
            <div className="mt-1.5 text-2xl font-semibold text-fg tabular-nums">
              {graphSize.nodes == null ? "—" : graphSize.nodes.toLocaleString()}
            </div>
          </div>
          <div className="rounded border border-border bg-bg-muted/30 px-4 py-3">
            <div className="text-[11px] uppercase tracking-wide text-fg-muted">Edges</div>
            <div className="mt-1.5 text-2xl font-semibold text-fg tabular-nums">
              {graphSize.edges == null ? "—" : graphSize.edges.toLocaleString()}
            </div>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <GraphTypeList label="Top node types" types={graphSize.topNodeTypes} />
          <GraphTypeList label="Top edge types" types={graphSize.topEdgeTypes} />
        </div>
        <p className="text-[11px] text-fg-subtle">absolute graph size, not write volume</p>
      </CardBody>
    </Card>
  );
}

function GraphTypeList({
  label,
  types,
}: {
  label: string;
  types: { type: string; count: number }[];
}) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-fg-subtle mb-1">{label}</div>
      {types.length === 0 ? (
        <p className="text-[11px] text-fg-muted">—</p>
      ) : (
        <ul className="space-y-0.5">
          {types.map((t, i) => (
            <li key={`${t.type}-${i}`} className="flex items-center justify-between gap-2 text-[11px]">
              <span className="font-mono text-fg-muted truncate" title={t.type}>
                {t.type}
              </span>
              <span className="font-mono text-fg shrink-0">{t.count.toLocaleString()}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
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

function ConfigRow({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <span className="text-fg-muted">{label}</span>
      <span className="font-mono text-fg truncate text-right" title={value ?? undefined}>
        {value ?? "—"}
      </span>
    </div>
  );
}

function TenantConfigCard({ config }: { config: TenantConfigInfo }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Server className="h-4 w-4 text-accent" /> Tenant config
        </CardTitle>
      </CardHeader>
      <CardBody className="space-y-1.5">
        <ConfigRow label="Cluster" value={config.cluster} />
        <ConfigRow label="Namespace" value={config.namespace} />
        <ConfigRow label="Region" value={config.region} />
        <ConfigRow label="Insight-point version" value={config.insightPointVersion} />
        <ConfigRow label="EDP id" value={config.edpId} />
        <p className="pt-1 text-[11px] text-fg-subtle">from Grafana labels + data-plane logs</p>
        <p className="text-[11px] text-fg-subtle">
          Extraction schedule requires the Veza control-plane API (not yet connected).
        </p>
      </CardBody>
    </Card>
  );
}

function FeatureFlagsCard({ featureFlags }: { featureFlags: TenantFeatureFlags | null }) {
  const empty =
    !featureFlags ||
    (featureFlags.current.length === 0 && featureFlags.changes.length === 0);

  if (empty) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Flag className="h-4 w-4 text-accent" /> Feature flags
          </CardTitle>
        </CardHeader>
        <CardBody>
          <p className="text-sm text-fg-muted">No dynamic feature flags recorded.</p>
        </CardBody>
      </Card>
    );
  }

  const changes = [...featureFlags.changes]
    .sort((a, b) => new Date(b.t).getTime() - new Date(a.t).getTime())
    .slice(0, 6);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Flag className="h-4 w-4 text-accent" /> Feature flags
        </CardTitle>
        <Badge>{featureFlags.current.length}</Badge>
      </CardHeader>
      <CardBody className="space-y-3">
        <div>
          {featureFlags.current.length === 0 ? (
            <p className="text-sm text-fg-muted">No flags currently set.</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {featureFlags.current.map((flag) => (
                <span
                  key={flag}
                  className="rounded border border-accent/30 bg-accent/10 px-1.5 py-0.5 font-mono text-[11px] text-accent"
                >
                  {flag}
                </span>
              ))}
            </div>
          )}
          <p className="pt-1.5 text-[11px] text-fg-subtle">dynamic (NRR_*) flags</p>
        </div>

        {changes.length > 0 && (
          <div className="space-y-1.5 border-t border-border pt-3">
            <div className="text-[11px] uppercase tracking-wide text-fg-subtle">Change history</div>
            {changes.map((c, i) => (
              <div key={`${c.t}-${i}`} className="flex items-start gap-2 text-[11px]">
                <span className="inline-flex items-center gap-1 shrink-0 font-mono text-fg-muted">
                  <Clock className="h-3 w-3" />
                  {new Date(c.t).toLocaleString()}
                </span>
                <span
                  className="font-mono text-fg-subtle truncate"
                  title={c.flags.join(", ")}
                >
                  {c.flags.join(", ") || "—"}
                </span>
              </div>
            ))}
          </div>
        )}
      </CardBody>
    </Card>
  );
}

const TL_WIDTH = 800;
const TL_HEIGHT = 220;
const TL_PADDING = { top: 16, right: 18, bottom: 44, left: 52 };
const TL_LINE = "hsl(8 80% 58%)"; // error red

/** Round a count up to a "nice" axis maximum (1/2/5 × 10ⁿ). */
function niceMax(v: number): number {
  if (v <= 1) return 1;
  if (v <= 5) return 5;
  const order = Math.pow(10, Math.floor(Math.log10(v)));
  const norm = v / order;
  const nice = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return nice * order;
}

/** Compact axis number: 2000 -> "2k", 1500 -> "1.5k". */
function fmtCompact(v: number): string {
  if (v >= 1000) {
    const k = v / 1000;
    return `${Number.isInteger(k) ? k : k.toFixed(1)}k`;
  }
  return String(v);
}

/** Short clock label for an x tick, e.g. "9 PM". */
function fmtHour(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "numeric" });
}

function ErrorTimeline({ points }: { points: ErrorTimelinePoint[] }) {
  const [hover, setHover] = useState<number | null>(null);

  const max = points.reduce((m, p) => Math.max(m, p.count), 0);
  if (points.length === 0 || max === 0) {
    return <p className="text-sm text-fg-muted">No extraction errors in the window.</p>;
  }

  const innerW = TL_WIDTH - TL_PADDING.left - TL_PADDING.right;
  const innerH = TL_HEIGHT - TL_PADDING.top - TL_PADDING.bottom;
  const maxY = niceMax(max);
  const x = (i: number) =>
    TL_PADDING.left + (points.length <= 1 ? innerW / 2 : (i / (points.length - 1)) * innerW);
  const y = (v: number) => TL_PADDING.top + innerH - (v / maxY) * innerH;

  const linePath = points.map((p, i) => `${i === 0 ? "M" : "L"} ${x(i)} ${y(p.count)}`).join(" ");
  const areaPath = `${linePath} L ${x(points.length - 1)} ${y(0)} L ${x(0)} ${y(0)} Z`;

  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((t) => Math.round(t * maxY));
  const xStep = Math.max(1, Math.floor(points.length / 6));
  const xTickIndices: number[] = [];
  for (let i = 0; i < points.length; i += xStep) xTickIndices.push(i);
  if (xTickIndices[xTickIndices.length - 1] !== points.length - 1) xTickIndices.push(points.length - 1);

  return (
    <div className="relative" onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${TL_WIDTH} ${TL_HEIGHT}`} className="w-full h-auto" preserveAspectRatio="none">
        {/* Y gridlines + tick labels */}
        {yTicks.map((v, i) => {
          const yPos = y(v);
          return (
            <g key={i}>
              <line
                x1={TL_PADDING.left}
                x2={TL_WIDTH - TL_PADDING.right}
                y1={yPos}
                y2={yPos}
                stroke="hsl(220 13% 20%)"
                strokeWidth="1"
                strokeDasharray={i === 0 ? "" : "2 3"}
              />
              <text
                x={TL_PADDING.left - 8}
                y={yPos}
                textAnchor="end"
                dominantBaseline="middle"
                fill="hsl(220 8% 45%)"
                fontSize="10"
                fontFamily="ui-monospace, Menlo, monospace"
              >
                {fmtCompact(v)}
              </text>
            </g>
          );
        })}

        {/* X tick labels */}
        {xTickIndices.map((i) => (
          <text
            key={i}
            x={x(i)}
            y={TL_HEIGHT - TL_PADDING.bottom + 16}
            textAnchor="middle"
            fill="hsl(220 8% 45%)"
            fontSize="10"
            fontFamily="ui-monospace, Menlo, monospace"
          >
            {fmtHour(points[i].t)}
          </text>
        ))}

        {/* Axis names */}
        <text
          x={TL_PADDING.left + innerW / 2}
          y={TL_HEIGHT - 6}
          textAnchor="middle"
          fill="hsl(220 8% 55%)"
          fontSize="11"
        >
          Time (hourly)
        </text>
        <text
          x={14}
          y={TL_PADDING.top + innerH / 2}
          textAnchor="middle"
          fill="hsl(220 8% 55%)"
          fontSize="11"
          transform={`rotate(-90 14 ${TL_PADDING.top + innerH / 2})`}
        >
          Errors
        </text>

        {/* Area + line */}
        <path d={areaPath} fill={TL_LINE} fillOpacity="0.08" />
        <path d={linePath} fill="none" stroke={TL_LINE} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />

        {/* Hover hit zones */}
        {points.map((_, i) => {
          const w = innerW / Math.max(1, points.length - 1);
          return (
            <rect
              key={i}
              x={x(i) - w / 2}
              y={TL_PADDING.top}
              width={w}
              height={innerH}
              fill="transparent"
              onMouseEnter={() => setHover(i)}
            />
          );
        })}

        {/* Hover indicator */}
        {hover !== null && (
          <>
            <line
              x1={x(hover)}
              x2={x(hover)}
              y1={TL_PADDING.top}
              y2={TL_HEIGHT - TL_PADDING.bottom}
              stroke="hsl(220 10% 96%)"
              strokeWidth="1"
              strokeDasharray="2 3"
              opacity="0.4"
            />
            <circle cx={x(hover)} cy={y(points[hover].count)} r="3.5" fill={TL_LINE} />
          </>
        )}
      </svg>

      {hover !== null && (
        <div
          className="absolute -translate-x-1/2 pointer-events-none"
          style={{ left: `${(x(hover) / TL_WIDTH) * 100}%`, top: 0 }}
        >
          <div className="mt-1 rounded border border-border-strong bg-bg-card px-2.5 py-1.5 text-[11px] shadow-lg whitespace-nowrap">
            <div className="font-mono text-fg-subtle mb-0.5">{new Date(points[hover].t).toLocaleString()}</div>
            <div className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: TL_LINE }} />
              <span className="text-fg-muted">Errors</span>
              <span className="font-mono text-fg ml-1">{points[hover].count.toLocaleString()}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Priority pill color: P0/highest = danger, P1/high = warning, else muted. */
function priorityClass(priority: string | null): string {
  const p = (priority ?? "").toLowerCase();
  if (/p0|blocker|highest/.test(p)) return "border-danger/40 bg-danger/10 text-danger";
  if (/p1|critical|high/.test(p)) return "border-warning/40 bg-warning/10 text-warning";
  return "border-border-strong bg-bg-muted text-fg-muted";
}

function JiraTicketRow({ ticket }: { ticket: TenantJiraTicket }) {
  return (
    <div className="flex items-center gap-2 rounded border border-border bg-bg-muted/30 px-3 py-2">
      {ticket.priority && (
        <Badge className={cn("border shrink-0 font-mono", priorityClass(ticket.priority))}>
          {ticket.priority}
        </Badge>
      )}
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
      <span
        className={cn(
          "text-[11px] shrink-0 max-w-[9rem] truncate",
          ticket.assignee ? "text-fg-muted" : "text-fg-subtle italic",
        )}
        title={ticket.assignee ?? "Unassigned"}
      >
        {ticket.assignee ?? "Unassigned"}
      </span>
      <StatusChip status={ticket.status} />
    </div>
  );
}

function ProjectTicketSection({ group }: { group: ProjectTicketGroup }) {
  const [showDone, setShowDone] = useState(false);
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-fg">{group.project}</h3>
        <span className="text-[11px] text-fg-subtle">
          {group.open.length} open
          {group.done.length > 0 && ` · ${group.done.length} done`}
        </span>
      </div>

      {group.open.length === 0 && group.done.length === 0 ? (
        <p className="text-[11px] text-fg-subtle pl-0.5">No tickets.</p>
      ) : (
        <>
          {group.open.map((t) => (
            <JiraTicketRow key={t.key} ticket={t} />
          ))}
          {group.open.length === 0 && (
            <p className="text-[11px] text-fg-subtle pl-0.5">No open tickets.</p>
          )}

          {group.done.length > 0 && (
            <div className="space-y-1.5">
              <button
                type="button"
                onClick={() => setShowDone((v) => !v)}
                aria-expanded={showDone}
                className="inline-flex items-center gap-1 text-[11px] font-medium text-fg-muted hover:text-fg"
              >
                <ChevronRight className={cn("h-3 w-3 transition-transform", showDone && "rotate-90")} />
                {showDone ? "Hide" : "Show"} {group.done.length} done
              </button>
              {showDone && (
                <div className="space-y-1.5 opacity-70">
                  {group.done.map((t) => (
                    <JiraTicketRow key={t.key} ticket={t} />
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}
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
  value: number | null;
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
        {value == null ? "—" : value.toLocaleString()}
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
