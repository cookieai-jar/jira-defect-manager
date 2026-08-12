import { NextResponse } from "next/server";
import { getConfig } from "@/lib/config";
import { latestReport, listIssues } from "@/lib/db";
import { buildOverview, type ScopeInput } from "@/lib/overview-core";
import { SCOPES, SCOPE_LABELS, scopeHasP0, type Scope } from "@/types/triage";

export const dynamic = "force-dynamic";

/** Dashboard path for each triage scope. */
const SCOPE_HREF: Record<Scope, string> = {
  eac: "/",
  fr: "/fr/poc",
  sec: "/security",
  alerts: "/alerts",
  incidents: "/incidents",
  alldefects: "/all-defects",
  ops: "/ops",
  automation: "/automation",
};

export async function GET() {
  const config = getConfig();
  const jiraBaseUrl = process.env.JIRA_BASE_URL?.replace(/\/$/, "") ?? "";

  const inputs: ScopeInput[] = SCOPES.filter(
    (s) => config.dashboards?.[s] !== false,
  ).map((scope) => ({
    scope,
    label: SCOPE_LABELS[scope],
    href: SCOPE_HREF[scope],
    hasP0: scopeHasP0(scope),
    // Feature requests aren't defects — a bug SLA window doesn't apply to them.
    slaApplies: scope !== "fr",
    jiraBaseUrl,
    report: latestReport(scope),
    issues: listIssues(scope),
  }));

  const overview = buildOverview(inputs, new Date().toISOString());
  return NextResponse.json({ ...overview, jiraBaseUrl });
}
