"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Markdown } from "@/components/markdown";
import { IntegrationsSyncButton } from "@/components/integrations-sync-button";
import { IntegrationsExportButton } from "@/components/integrations-export-button";
import { cn } from "@/lib/utils";
import {
  AlertTriangle,
  AppWindow,
  Boxes,
  ChevronDown,
  Cloud,
  Database,
  ExternalLink,
  Fingerprint,
  FlaskConical,
  Inbox,
  Layers,
  ListChecks,
  Network,
  Wrench,
} from "lucide-react";
import type {
  ActionPriority,
  Effort,
  HardeningStep,
  IntegrationInsight,
  IntegrationsAnalysis,
  IssueCategory,
} from "@/types/integrations";
import { buildDistribution, type IntegrationDistribution } from "@/lib/strategic-integrations";

interface ReportResponse {
  report: IntegrationsAnalysis | null;
  issues: { key: string; summary: string }[];
  jiraBaseUrl: string;
}

export function IntegrationsDashboard() {
  const [report, setReport] = useState<IntegrationsAnalysis | null>(null);
  const [jiraBaseUrl, setJiraBaseUrl] = useState("");
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const data = (await fetch("/api/integrations/report").then((r) => r.json())) as ReportResponse;
      setReport(data.report);
      setJiraBaseUrl(data.jiraBaseUrl ?? "");
    } finally {
      setLoading(false);
    }
  }, []);

  const insightByKey = useMemo(
    () => new Map((report?.integrationInsights ?? []).map((i) => [i.key, i])),
    [report],
  );

  useEffect(() => {
    refresh();
  }, [refresh]);

  const rootCauseCount = useMemo(
    () => (report?.categories ?? []).reduce((n, c) => n + c.rootCauses.length, 0),
    [report],
  );
  const hardeningCount = (report?.developerHardening.length ?? 0) + (report?.qaHardening.length ?? 0);

  const distribution = useMemo(
    () => (report ? buildDistribution(report.signals, report.categories) : null),
    [report],
  );

  return (
    <div className="flex-1 overflow-auto scroll-thin">
      <header className="px-6 h-14 border-b border-border flex items-center justify-between sticky top-0 z-10 bg-bg/90 backdrop-blur">
        <div>
          <h1 className="text-lg font-semibold">Integrations Hardening</h1>
          {report && (
            <p className="text-[11px] text-fg-subtle">
              Analyzed {new Date(report.generatedAt).toLocaleString()}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {report && report.analyzedTickets > 0 && (
            <IntegrationsExportButton report={report} jiraBaseUrl={jiraBaseUrl} />
          )}
          <IntegrationsSyncButton onSynced={refresh} />
        </div>
      </header>

      {!report ? (
        <EmptyState loading={loading} />
      ) : report.analyzedTickets === 0 ? (
        <div className="p-6">
          <Card>
            <CardBody className="text-center text-fg-muted text-sm py-10 space-y-2">
              <Inbox className="h-5 w-5 text-fg-subtle mx-auto" />
              <Markdown>{report.executiveSummary}</Markdown>
              <p className="text-xs text-fg-subtle">
                Adjust the Integrations Hardening JQL in{" "}
                <a href="/settings" className="text-accent underline">
                  Settings
                </a>{" "}
                and run the analysis again.
              </p>
            </CardBody>
          </Card>
        </div>
      ) : (
        <div className="p-6 space-y-6">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Stat icon={<Inbox className="h-4 w-4" />} label="Tickets analyzed" value={report.analyzedTickets} />
            <Stat icon={<Layers className="h-4 w-4 text-accent" />} label="Issue categories" value={report.categories.length} />
            <Stat icon={<AlertTriangle className="h-4 w-4 text-warning" />} label="Root causes" value={rootCauseCount} tone="warning" />
            <Stat icon={<ListChecks className="h-4 w-4 text-success" />} label="Hardening steps" value={hardeningCount} tone="success" />
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Boxes className="h-4 w-4 text-accent" /> Executive summary
              </CardTitle>
            </CardHeader>
            <CardBody>
              <Markdown jiraBaseUrl={jiraBaseUrl}>{report.executiveSummary}</Markdown>
            </CardBody>
          </Card>

          <section className="space-y-3">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold">Issue categories</h2>
              <span className="text-xs text-fg-muted">{report.categories.length} found · by volume</span>
            </div>
            {report.categories.length === 0 ? (
              <Card>
                <CardBody className="text-fg-muted text-sm py-6 text-center">
                  No categories were produced.
                </CardBody>
              </Card>
            ) : (
              <div className="space-y-3">
                {report.categories.map((c, i) => (
                  <CategoryCard
                    key={c.key}
                    category={c}
                    defaultOpen={i === 0}
                    jiraBaseUrl={jiraBaseUrl}
                  />
                ))}
              </div>
            )}
          </section>

          <section className="grid grid-cols-1 lg:grid-cols-2 gap-3 items-start">
            <HardeningColumn
              title="Developer hardening"
              icon={<Wrench className="h-4 w-4 text-accent" />}
              steps={report.developerHardening}
            />
            <HardeningColumn
              title="Quality Engineering hardening"
              icon={<FlaskConical className="h-4 w-4 text-success" />}
              steps={report.qaHardening}
            />
          </section>

          {distribution && (
            <DistributionSection
              distribution={distribution}
              insightByKey={insightByKey}
              jiraBaseUrl={jiraBaseUrl}
            />
          )}
        </div>
      )}
    </div>
  );
}

const GROUP_ICONS: Record<string, React.ReactNode> = {
  cloud: <Cloud className="h-4 w-4 text-accent" />,
  identity: <Fingerprint className="h-4 w-4 text-accent" />,
  databases: <Database className="h-4 w-4 text-accent" />,
  saas: <AppWindow className="h-4 w-4 text-accent" />,
};

function DistributionSection({
  distribution,
  insightByKey,
  jiraBaseUrl,
}: {
  distribution: ReturnType<typeof buildDistribution>;
  insightByKey: Map<string, IntegrationInsight>;
  jiraBaseUrl: string;
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <Network className="h-4 w-4 text-accent" />
        <h2 className="text-sm font-semibold">Distribution &amp; failure analysis by strategic integration</h2>
        <span className="text-xs text-fg-muted">
          {distribution.matched} tickets across strategic integrations
          {distribution.unmatched > 0 && (
            <span className="text-fg-subtle"> · {distribution.unmatched} on other integrations</span>
          )}
        </span>
      </div>
      <p className="text-[11px] text-fg-subtle">
        For each integration: what is failing, why/how, what to do — plus the ticket spread across
        issue categories. Expand an integration for the full analysis.
      </p>
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3 items-start">
        {distribution.groups.map((group) => (
          <Card key={group.key}>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                {GROUP_ICONS[group.key] ?? <Boxes className="h-4 w-4 text-accent" />} {group.label}
              </CardTitle>
              <Badge>{group.total}</Badge>
            </CardHeader>
            <CardBody className="space-y-1.5">
              {group.integrations.map((integration) => (
                <IntegrationDistRow
                  key={integration.key}
                  integration={integration}
                  insight={insightByKey.get(integration.key)}
                  jiraBaseUrl={jiraBaseUrl}
                />
              ))}
            </CardBody>
          </Card>
        ))}
      </div>
    </section>
  );
}

function IntegrationDistRow({
  integration,
  insight,
  jiraBaseUrl,
}: {
  integration: IntegrationDistribution;
  insight?: IntegrationInsight;
  jiraBaseUrl: string;
}) {
  const [open, setOpen] = useState(false);
  const allKeys = integration.byCategory.flatMap((b) => b.issueKeys);
  const catInsightByName = new Map((insight?.categoryInsights ?? []).map((ci) => [ci.category, ci]));

  if (integration.total === 0) {
    return (
      <div className="flex items-center justify-between px-2 py-1.5 rounded text-sm">
        <span className="text-fg-subtle">{integration.label}</span>
        <span className="text-[11px] text-fg-subtle">no tickets</span>
      </div>
    );
  }

  return (
    <div className="rounded border border-border bg-bg-muted/30">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full px-2 py-1.5 flex items-center justify-between gap-2 text-left hover:bg-bg-muted/50 transition-colors rounded"
        aria-expanded={open}
      >
        <span className="flex items-center gap-1.5 min-w-0">
          <ChevronDown
            className={cn("h-3.5 w-3.5 text-fg-muted transition-transform shrink-0", open ? "rotate-0" : "-rotate-90")}
          />
          <span className="text-sm font-medium truncate">{integration.label}</span>
          <span className="text-[11px] text-fg-subtle">· {integration.byCategory.length} categories</span>
        </span>
        <Badge className="border-accent/40 bg-accent/10 text-accent border font-mono">
          {integration.total}
        </Badge>
      </button>
      {open && (
        <div className="px-3 pb-3 pt-1 space-y-3">
          {insight?.summary && (
            <div className="text-xs">
              <Markdown jiraBaseUrl={jiraBaseUrl}>{insight.summary}</Markdown>
            </div>
          )}

          <div className="space-y-2">
            <div className="text-[11px] uppercase tracking-wide text-fg-subtle">By issue category</div>
            <ul className="space-y-2">
              {integration.byCategory.map((bucket) => {
                const ci = catInsightByName.get(bucket.category);
                return (
                  <li
                    key={bucket.category}
                    className="rounded border border-border bg-bg-card px-2.5 py-2 space-y-1.5"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-medium text-fg truncate">
                        {bucket.category}{" "}
                        <span className="text-fg-subtle font-mono">· {bucket.issueKeys.length}</span>
                      </span>
                      <JiraQueryLink
                        keys={bucket.issueKeys}
                        jiraBaseUrl={jiraBaseUrl}
                        label={`open ${bucket.issueKeys.length} ticket${bucket.issueKeys.length === 1 ? "" : "s"} in JIRA`}
                      />
                    </div>
                    {ci?.analysis && (
                      <div className="text-[11px] text-fg-muted">
                        <Markdown jiraBaseUrl={jiraBaseUrl}>{ci.analysis}</Markdown>
                      </div>
                    )}
                    {ci && ci.actions.length > 0 && (
                      <ul className="text-[11px] text-fg-muted space-y-0.5">
                        {ci.actions.map((a, i) => (
                          <li key={i} className="flex items-start gap-1.5">
                            <ListChecks className="h-3 w-3 text-success mt-0.5 shrink-0" />
                            <span>{a}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>

          <div className="pt-1 border-t border-border">
            <JiraQueryLink keys={allKeys} jiraBaseUrl={jiraBaseUrl} />
          </div>
        </div>
      )}
    </div>
  );
}

const PRIORITY_STYLES: Record<ActionPriority, string> = {
  now: "border-danger/40 bg-danger/10 text-danger",
  next: "border-warning/40 bg-warning/10 text-warning",
  later: "border-fg-subtle/40 bg-fg-subtle/10 text-fg-muted",
};
const EFFORT_STYLES: Record<Effort, string> = {
  low: "border-success/40 bg-success/10 text-success",
  medium: "border-warning/40 bg-warning/10 text-warning",
  high: "border-danger/40 bg-danger/10 text-danger",
};

function CategoryCard({
  category,
  defaultOpen,
  jiraBaseUrl,
}: {
  category: IssueCategory;
  defaultOpen?: boolean;
  jiraBaseUrl: string;
}) {
  const [open, setOpen] = useState(defaultOpen ?? false);
  return (
    <Card className="overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "w-full px-4 py-3 flex items-center justify-between gap-3 text-left transition-colors",
          open ? "border-b border-border bg-bg-muted/40" : "hover:bg-bg-muted/40",
        )}
        aria-expanded={open}
      >
        <div className="flex items-center gap-2 min-w-0">
          <ChevronDown
            className={cn("h-4 w-4 text-fg-muted transition-transform shrink-0", open ? "rotate-0" : "-rotate-90")}
          />
          <h3 className="text-sm font-semibold truncate">{category.name}</h3>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Badge className="border-accent/40 bg-accent/10 text-accent border font-mono">
            {category.share}%
          </Badge>
          <span className="text-[11px] text-fg-subtle">
            <span className="text-fg-muted">{category.ticketCount}</span> tickets
          </span>
        </div>
      </button>

      {open && (
        <CardBody className="space-y-4">
          {category.description && <p className="text-sm text-fg-muted">{category.description}</p>}

          {category.topIntegrations.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] uppercase tracking-wide text-fg-subtle mr-1">Affected</span>
              {category.topIntegrations.map((t) => (
                <Badge key={t} className="border-border-strong">
                  {t}
                </Badge>
              ))}
            </div>
          )}

          {category.rootCauses.length > 0 && (
            <div className="space-y-2">
              <div className="text-[11px] uppercase tracking-wide text-fg-subtle">Root causes</div>
              <ul className="space-y-2.5">
                {category.rootCauses.map((rc, i) => (
                  <li key={i} className="rounded border border-border bg-bg-muted/40 px-3 py-2 space-y-1">
                    <div className="text-sm font-medium text-fg flex items-center gap-1.5">
                      <AlertTriangle className="h-3.5 w-3.5 text-warning shrink-0" />
                      {rc.title}
                    </div>
                    {rc.explanation && (
                      <div className="text-xs">
                        <Markdown jiraBaseUrl={jiraBaseUrl}>{rc.explanation}</Markdown>
                      </div>
                    )}
                    {rc.contributingFactors.length > 0 && (
                      <ul className="text-xs text-fg-muted list-disc pl-4">
                        {rc.contributingFactors.map((f, j) => (
                          <li key={j}>{f}</li>
                        ))}
                      </ul>
                    )}
                    {rc.issueKeys.length > 0 && (
                      <JiraQueryLink
                        keys={rc.issueKeys}
                        jiraBaseUrl={jiraBaseUrl}
                        label={`Evidence · ${rc.issueKeys.length} ticket${rc.issueKeys.length === 1 ? "" : "s"} in JIRA`}
                      />
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {category.exampleQuotes.length > 0 && (
            <div className="space-y-1">
              <div className="text-[11px] uppercase tracking-wide text-fg-subtle">Example signals</div>
              <ul className="space-y-1">
                {category.exampleQuotes.map((q, i) => (
                  <li key={i} className="text-xs text-fg-muted border-l-2 border-border pl-2 italic">
                    “{q}”
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="flex items-center gap-2 pt-1 border-t border-border">
            <span className="text-[11px] uppercase tracking-wide text-fg-subtle">
              Tickets ({category.issueKeys.length})
            </span>
            <JiraQueryLink keys={category.issueKeys} jiraBaseUrl={jiraBaseUrl} />
          </div>
        </CardBody>
      )}
    </Card>
  );
}

/**
 * A single link that opens all the given tickets in JIRA via a `key in (...)`
 * JQL search — replaces long lists of individual ticket chips.
 */
function JiraQueryLink({
  keys,
  jiraBaseUrl,
  label,
}: {
  keys: string[];
  jiraBaseUrl: string;
  label?: string;
}) {
  const count = keys.length;
  if (count === 0) return null;
  const text = label ?? `View ${count} ticket${count === 1 ? "" : "s"} in JIRA`;
  if (!jiraBaseUrl) {
    return <span className="text-[11px] text-fg-subtle">{count} ticket{count === 1 ? "" : "s"}</span>;
  }
  const jql = `key in (${keys.join(",")}) ORDER BY created DESC`;
  const href = `${jiraBaseUrl}/issues/?jql=${encodeURIComponent(jql)}`;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 text-[11px] font-medium text-accent hover:text-accent-hover underline decoration-accent/40 hover:decoration-accent"
    >
      {text}
      <ExternalLink className="h-3 w-3" />
    </a>
  );
}

function HardeningColumn({
  title,
  icon,
  steps,
}: {
  title: string;
  icon: React.ReactNode;
  steps: HardeningStep[];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {icon} {title}
        </CardTitle>
        <Badge>{steps.length}</Badge>
      </CardHeader>
      <CardBody>
        {steps.length === 0 ? (
          <p className="text-sm text-fg-muted">No steps recommended.</p>
        ) : (
          <ul className="space-y-1.5">
            {steps.map((s, i) => (
              <HardeningStepRow key={i} step={s} />
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}

function HardeningStepRow({ step }: { step: HardeningStep }) {
  const [open, setOpen] = useState(false);
  const hasDetail = Boolean(step.detail) || Boolean(step.category);
  return (
    <li className="rounded border border-border bg-bg-muted/40">
      <button
        type="button"
        onClick={() => hasDetail && setOpen((o) => !o)}
        className={cn(
          "w-full px-3 py-2 flex items-start justify-between gap-2 text-left",
          hasDetail && "hover:bg-bg-muted/60 transition-colors",
        )}
        aria-expanded={hasDetail ? open : undefined}
      >
        <div className="flex items-start gap-1.5 min-w-0">
          {hasDetail && (
            <ChevronDown
              className={cn(
                "h-3.5 w-3.5 text-fg-muted transition-transform shrink-0 mt-0.5",
                open ? "rotate-0" : "-rotate-90",
              )}
            />
          )}
          <span className="text-sm font-medium text-fg">{step.title}</span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Badge className={cn("border", PRIORITY_STYLES[step.priority])}>{step.priority}</Badge>
          <Badge className={cn("border", EFFORT_STYLES[step.effort])}>{step.effort}</Badge>
        </div>
      </button>
      {open && hasDetail && (
        <div className="px-3 pb-2.5 pl-8 space-y-1">
          {step.detail && (
            <div className="text-xs">
              <Markdown>{step.detail}</Markdown>
            </div>
          )}
          {step.category && (
            <div className="text-[11px] text-fg-subtle">Addresses: {step.category}</div>
          )}
        </div>
      )}
    </li>
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
      <div className={`mt-1.5 text-2xl font-semibold ${toneCls}`}>{value}</div>
    </div>
  );
}

function EmptyState({ loading }: { loading: boolean }) {
  return (
    <div className="flex-1 flex items-center justify-center p-12">
      <div className="max-w-md text-center space-y-3">
        <div className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-accent/15 border border-accent/30">
          <Boxes className="h-5 w-5 text-accent" />
        </div>
        <h2 className="text-lg font-semibold">
          {loading ? "Loading…" : "No integrations analysis yet"}
        </h2>
        <p className="text-sm text-fg-muted">
          Configure the Integrations Hardening JQL in <span className="text-fg">Settings</span>, then
          click <span className="text-fg">Sync &amp; Analyze</span> to pull tickets and run the deep
          pattern analysis — issue categories, root causes, and developer/QE hardening steps.
        </p>
      </div>
    </div>
  );
}
