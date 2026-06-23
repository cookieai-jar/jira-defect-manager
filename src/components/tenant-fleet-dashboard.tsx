"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Card, CardBody } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  HeartPulse,
  Inbox,
  PlugZap,
  RefreshCw,
  Search,
  Server,
} from "lucide-react";
import type { FleetReport, FleetTenantSummary, Severity } from "@/types/tenant";

interface FleetResponse {
  report: FleetReport | null;
  error?: string;
}

type SortKey = "health" | "alerts" | "extractions";

const SEVERITY_DOT: Record<Severity, string> = {
  critical: "bg-danger",
  warning: "bg-warning",
  ok: "bg-success",
};

function healthTone(score: number): "green" | "yellow" | "red" {
  if (score >= 80) return "green";
  if (score >= 50) return "yellow";
  return "red";
}

const HEALTH_BAR: Record<"green" | "yellow" | "red", string> = {
  green: "bg-success",
  yellow: "bg-warning",
  red: "bg-danger",
};
const HEALTH_TEXT: Record<"green" | "yellow" | "red", string> = {
  green: "text-success",
  yellow: "text-warning",
  red: "text-danger",
};

export function TenantFleetDashboard() {
  const router = useRouter();
  const [report, setReport] = useState<FleetReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" } | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = (await fetch("/api/tenant/fleet").then((r) => r.json())) as FleetResponse;
      setReport(data.report);
      setError(data.error ?? null);
    } catch (e) {
      setReport(null);
      setError(e instanceof Error ? e.message : "Failed to load fleet report");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const rows = useMemo(() => {
    const base = report?.tenants ?? [];
    const q = query.trim().toLowerCase();
    const filtered = q
      ? base.filter(
          (t) =>
            t.tenant.toLowerCase().includes(q) || t.displayName.toLowerCase().includes(q),
        )
      : base;
    // Keep API order (worst-first) unless the user picked a sort.
    if (!sort) return filtered;
    const valueOf = (t: FleetTenantSummary): number =>
      sort.key === "health"
        ? t.healthScore
        : sort.key === "alerts"
          ? t.activeAlerts
          : t.extractions;
    const sorted = [...filtered].sort((a, b) => valueOf(a) - valueOf(b));
    if (sort.dir === "desc") sorted.reverse();
    return sorted;
  }, [report, query, sort]);

  const toggleSort = useCallback((key: SortKey) => {
    setSort((prev) => {
      if (prev?.key !== key) return { key, dir: "desc" };
      if (prev.dir === "desc") return { key, dir: "asc" };
      return null; // third click clears -> back to API order
    });
  }, []);

  return (
    <div className="flex-1 overflow-auto scroll-thin">
      <header className="px-6 h-14 border-b border-border flex items-center justify-between sticky top-0 z-10 bg-bg/90 backdrop-blur">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold flex items-center gap-2">
            <HeartPulse className="h-4 w-4 text-accent" />
            Tenant Health
          </h1>
          <p className="text-[11px] text-fg-subtle">Fleet overview · all tenants ranked by health</p>
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
          {/* Summary stat tiles */}
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <Stat
              icon={<Server className="h-4 w-4 text-accent" />}
              label="Tenants"
              value={report.totals.tenants}
            />
            <Stat
              icon={<AlertTriangle className="h-4 w-4 text-warning" />}
              label="Unhealthy"
              value={report.totals.unhealthy}
              tone={report.totals.unhealthy > 0 ? "warning" : undefined}
            />
            <Stat
              icon={<PlugZap className="h-4 w-4 text-danger" />}
              label="Active alerts"
              value={report.totals.activeAlerts}
              tone={report.totals.activeAlerts > 0 ? "danger" : undefined}
            />
          </div>

          {/* Search */}
          <div className="relative max-w-xs">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-fg-subtle" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search tenants…"
              className="w-full rounded border border-border bg-bg-card pl-8 pr-3 py-1.5 text-sm text-fg placeholder:text-fg-subtle focus:outline-none focus:border-accent/60"
            />
          </div>

          {/* Tenant table */}
          <Card>
            <CardBody className="px-0 py-0">
              {rows.length === 0 ? (
                <p className="text-sm text-fg-muted px-4 py-8 text-center">
                  {query ? "No tenants match your search." : "No tenants reported."}
                </p>
              ) : (
                <div className="overflow-auto scroll-thin">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-bg-card z-10">
                      <tr className="border-b border-border text-[11px] uppercase tracking-wide text-fg-subtle">
                        <th className="text-left font-medium px-4 py-2">Tenant</th>
                        <SortHeader
                          label="Health"
                          active={sort?.key === "health" ? sort.dir : null}
                          onClick={() => toggleSort("health")}
                        />
                        <th className="text-center font-medium px-3 py-2">Sev</th>
                        <th className="text-right font-medium px-3 py-2">Integrations</th>
                        <SortHeader
                          label="Extractions"
                          active={sort?.key === "extractions" ? sort.dir : null}
                          onClick={() => toggleSort("extractions")}
                        />
                        <th className="text-right font-medium px-3 py-2">Errors</th>
                        <SortHeader
                          label="Alerts"
                          active={sort?.key === "alerts" ? sort.dir : null}
                          onClick={() => toggleSort("alerts")}
                        />
                        <th className="text-left font-medium px-4 py-2">Top issue</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((t) => (
                        <TenantRow key={t.tenant} t={t} router={router} />
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardBody>
          </Card>
        </div>
      )}
    </div>
  );
}

function SortHeader({
  label,
  active,
  onClick,
}: {
  label: string;
  active: "asc" | "desc" | null;
  onClick: () => void;
}) {
  return (
    <th className="text-right font-medium px-3 py-2">
      <button
        type="button"
        onClick={onClick}
        className={cn(
          "inline-flex items-center gap-1 uppercase tracking-wide hover:text-fg transition-colors",
          active ? "text-fg" : "text-fg-subtle",
        )}
      >
        {label}
        {active === "asc" ? (
          <ArrowUp className="h-3 w-3" />
        ) : active === "desc" ? (
          <ArrowDown className="h-3 w-3" />
        ) : null}
      </button>
    </th>
  );
}

function TenantRow({
  t,
  router,
}: {
  t: FleetTenantSummary;
  router: ReturnType<typeof useRouter>;
}) {
  const href = `/tenants/${encodeURIComponent(t.tenant)}`;
  const tone = healthTone(t.healthScore);
  return (
    <tr
      onClick={() => router.push(href)}
      className="border-b border-border/60 last:border-0 hover:bg-bg-muted/40 transition-colors cursor-pointer"
    >
      <td className="px-4 py-2">
        <Link
          href={href}
          onClick={(e) => e.stopPropagation()}
          className="block min-w-0 group"
        >
          <div className="font-medium text-fg truncate group-hover:text-accent transition-colors">
            {t.displayName}
          </div>
          <div className="font-mono text-[11px] text-fg-subtle truncate">{t.tenant}</div>
        </Link>
      </td>
      <td className="px-3 py-2">
        <div className="flex items-center justify-end gap-2">
          <span className={cn("font-mono text-sm tabular-nums", HEALTH_TEXT[tone])}>
            {t.healthScore}
            <span className="text-fg-subtle">/100</span>
          </span>
          <span className="h-1.5 w-16 rounded-full bg-bg-muted overflow-hidden shrink-0">
            <span
              className={cn("block h-full rounded-full", HEALTH_BAR[tone])}
              style={{ width: `${Math.max(0, Math.min(100, t.healthScore))}%` }}
            />
          </span>
        </div>
      </td>
      <td className="px-3 py-2">
        <div className="flex justify-center">
          <span
            className={cn("inline-block h-2 w-2 rounded-full", SEVERITY_DOT[t.severity])}
            title={t.severity}
          />
        </div>
      </td>
      <td className="px-3 py-2 text-right font-mono text-fg-muted">
        {t.integrations.toLocaleString()}
      </td>
      <td className="px-3 py-2 text-right font-mono text-fg-muted">
        {t.extractions.toLocaleString()}
      </td>
      <td
        className={cn(
          "px-3 py-2 text-right font-mono",
          t.extractionErrors > 0 ? "text-danger" : "text-fg-subtle",
        )}
      >
        {t.extractionErrors.toLocaleString()}
      </td>
      <td className="px-3 py-2 text-right">
        {t.activeAlerts > 0 ? (
          <span className="font-mono text-xs">
            {t.warningAlerts > 0 && (
              <span className="text-warning">{t.warningAlerts}⚠</span>
            )}
            {t.warningAlerts > 0 && t.criticalAlerts > 0 && " "}
            {t.criticalAlerts > 0 && (
              <span className="text-danger">{t.criticalAlerts}✕</span>
            )}
          </span>
        ) : (
          <span className="font-mono text-fg-subtle">0</span>
        )}
      </td>
      <td className="px-4 py-2 max-w-[18rem]">
        <span className="block truncate text-fg-muted" title={t.topIssue ?? undefined}>
          {t.topIssue ?? "—"}
        </span>
      </td>
    </tr>
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
      <div className={`mt-1.5 text-2xl font-semibold ${toneCls}`}>
        {value.toLocaleString()}
      </div>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="flex-1 flex items-center justify-center p-12">
      <div className="flex flex-col items-center gap-3 text-fg-muted">
        <RefreshCw className="h-6 w-6 animate-spin text-accent" />
        <p className="text-sm">Loading fleet…</p>
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
        <h2 className="text-lg font-semibold">No fleet report</h2>
        <p className="text-sm text-fg-muted">
          {error
            ? `Couldn't load the fleet overview: ${error}`
            : "No fleet report is available yet. Try refreshing once the sync has run."}
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
