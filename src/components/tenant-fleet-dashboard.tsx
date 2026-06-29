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
  Crown,
  HeartPulse,
  Inbox,
  PlugZap,
  RefreshCw,
  Search,
  Server,
  Star,
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
  const [starred, setStarred] = useState<Set<string>>(new Set());

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

  // Starred tenants (manual watch-list) — independent of the report.
  useEffect(() => {
    fetch("/api/tenant/starred")
      .then((r) => r.json())
      .then((d: { starred?: string[] }) => setStarred(new Set(d.starred ?? [])))
      .catch(() => {});
  }, []);

  const toggleStar = useCallback(
    (tenant: string) => {
      // Decide + fire the request OUTSIDE the state updater — updaters must be
      // pure (React double-invokes them in StrictMode, which would double-fire).
      const willStar = !starred.has(tenant);
      setStarred((prev) => {
        const next = new Set(prev);
        if (willStar) next.add(tenant);
        else next.delete(tenant);
        return next;
      });
      const req = willStar
        ? fetch("/api/tenant/starred", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tenant }),
          })
        : fetch(`/api/tenant/starred?tenant=${encodeURIComponent(tenant)}`, { method: "DELETE" });
      req.catch(() => {});
    },
    [starred],
  );

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

  // Pinned watch-lists (kept in the API's worst-health-first order, not filtered
  // by search — they're the things you always want visible).
  const whiteGloveRows = useMemo(
    () => (report?.tenants ?? []).filter((t) => t.whiteGlove),
    [report],
  );
  const starredRows = useMemo(
    () => (report?.tenants ?? []).filter((t) => starred.has(t.tenant) && !t.whiteGlove),
    [report, starred],
  );

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

          {/* White-glove customers — the configured close-watch accounts */}
          {whiteGloveRows.length > 0 && (
            <FleetSection
              icon={<Crown className="h-4 w-4 text-warning" />}
              title="White-glove customers"
              subtitle="configured close-watch accounts"
              count={whiteGloveRows.length}
            >
              <TenantTable rows={whiteGloveRows} starred={starred} onToggleStar={toggleStar} router={router} />
            </FleetSection>
          )}

          {/* Starred — the manual watch-list */}
          {starredRows.length > 0 && (
            <FleetSection
              icon={<Star className="h-4 w-4 fill-warning text-warning" />}
              title="Starred"
              subtitle="tenants you're watching"
              count={starredRows.length}
            >
              <TenantTable rows={starredRows} starred={starred} onToggleStar={toggleStar} router={router} />
            </FleetSection>
          )}

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

          {/* Overall tenant list */}
          <FleetSection title="All tenants" count={rows.length}>
            {rows.length === 0 ? (
              <p className="text-sm text-fg-muted px-4 py-8 text-center">
                {query ? "No tenants match your search." : "No tenants reported."}
              </p>
            ) : (
              <TenantTable
                rows={rows}
                starred={starred}
                onToggleStar={toggleStar}
                router={router}
                sort={sort}
                onToggleSort={toggleSort}
              />
            )}
          </FleetSection>
        </div>
      )}
    </div>
  );
}

function FleetSection({
  icon,
  title,
  subtitle,
  count,
  children,
}: {
  icon?: React.ReactNode;
  title: string;
  subtitle?: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-2">
      <div className="flex items-baseline gap-2 px-0.5">
        <h2 className="text-sm font-semibold text-fg flex items-center gap-1.5">
          {icon}
          {title}
        </h2>
        <span className="text-[11px] text-fg-subtle">
          {count}
          {subtitle ? ` · ${subtitle}` : ""}
        </span>
      </div>
      <Card>
        <CardBody className="px-0 py-0">{children}</CardBody>
      </Card>
    </section>
  );
}

function TenantTable({
  rows,
  starred,
  onToggleStar,
  router,
  sort,
  onToggleSort,
}: {
  rows: FleetTenantSummary[];
  starred: Set<string>;
  onToggleStar: (tenant: string) => void;
  router: ReturnType<typeof useRouter>;
  sort?: { key: SortKey; dir: "asc" | "desc" } | null;
  onToggleSort?: (key: SortKey) => void;
}) {
  const sortable = !!onToggleSort;
  return (
    <div className="overflow-auto scroll-thin">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-bg-card z-10">
          <tr className="border-b border-border text-[11px] uppercase tracking-wide text-fg-subtle">
            <th className="w-8 px-2 py-2" aria-label="Star" />
            <th className="text-left font-medium px-4 py-2">Tenant</th>
            {sortable ? (
              <SortHeader label="Health" active={sort?.key === "health" ? sort.dir : null} onClick={() => onToggleSort!("health")} />
            ) : (
              <th className="text-right font-medium px-3 py-2">Health</th>
            )}
            <th className="text-center font-medium px-3 py-2">Sev</th>
            <th className="text-right font-medium px-3 py-2">Integrations</th>
            {sortable ? (
              <SortHeader label="Extractions" active={sort?.key === "extractions" ? sort.dir : null} onClick={() => onToggleSort!("extractions")} />
            ) : (
              <th className="text-right font-medium px-3 py-2">Extractions</th>
            )}
            <th className="text-right font-medium px-3 py-2">Errors</th>
            {sortable ? (
              <SortHeader label="Alerts" active={sort?.key === "alerts" ? sort.dir : null} onClick={() => onToggleSort!("alerts")} />
            ) : (
              <th className="text-right font-medium px-3 py-2">Alerts</th>
            )}
            <th className="text-left font-medium px-4 py-2">Top issue</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => (
            <TenantRow
              key={t.tenant}
              t={t}
              router={router}
              starred={starred.has(t.tenant)}
              onToggleStar={() => onToggleStar(t.tenant)}
            />
          ))}
        </tbody>
      </table>
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
  starred,
  onToggleStar,
}: {
  t: FleetTenantSummary;
  router: ReturnType<typeof useRouter>;
  starred: boolean;
  onToggleStar: () => void;
}) {
  const href = `/tenants/${encodeURIComponent(t.tenant)}`;
  const tone = healthTone(t.healthScore);
  return (
    <tr
      onClick={() => router.push(href)}
      className="border-b border-border/60 last:border-0 hover:bg-bg-muted/40 transition-colors cursor-pointer"
    >
      <td className="px-2 py-2">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onToggleStar();
          }}
          title={starred ? "Unstar — remove from your watch-list" : "Star — add to your watch-list"}
          aria-pressed={starred}
          className={cn(
            "inline-flex transition-colors",
            starred ? "text-warning" : "text-fg-subtle/50 hover:text-warning",
          )}
        >
          <Star className={cn("h-4 w-4", starred && "fill-warning")} />
        </button>
      </td>
      <td className="px-4 py-2">
        <Link
          href={href}
          onClick={(e) => e.stopPropagation()}
          className="block min-w-0 group"
        >
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="font-medium text-fg truncate group-hover:text-accent transition-colors">
              {t.displayName}
            </span>
            {t.whiteGlove && (
              <span title="White-glove customer" className="inline-flex shrink-0">
                <Crown className="h-3 w-3 text-warning" />
              </span>
            )}
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
