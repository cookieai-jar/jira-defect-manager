/**
 * Deep links into Grafana dashboards for drill-down. Pure URL builders — the
 * dashboards are templated by tenant_id / agent_type (verified live), so links
 * are just query-string construction. base is GRAFANA_URL (trailing slash trimmed).
 */

/** Generic per-connector dashboard (vars: tenant_id, agent_type, namespace). */
const CONNECTOR_DASHBOARD = "connector-detail";
/** "All Tenants — Integration & LCM Health" — the tenant health overview. */
const TENANT_HEALTH_DASHBOARD = "jd6cs94";

function trimBase(base: string | null | undefined): string | null {
  if (!base) return null;
  return base.replace(/\/$/, "");
}

/** Per-integration drill-down: the connector-detail dashboard scoped to this tenant + agent_type. */
export function connectorDetailUrl(
  base: string | null | undefined,
  tenant: string,
  agentType: string,
): string | null {
  const b = trimBase(base);
  if (!b) return null;
  const params = new URLSearchParams({
    "var-tenant_id": tenant,
    "var-agent_type": agentType,
    "var-namespace": `${tenant}-dp`,
  });
  return `${b}/d/${CONNECTOR_DASHBOARD}?${params.toString()}`;
}

/** Tenant-level drill-down: the integration & LCM health dashboard. */
export function tenantHealthDashboardUrl(base: string | null | undefined): string | null {
  const b = trimBase(base);
  return b ? `${b}/d/${TENANT_HEALTH_DASHBOARD}` : null;
}

/**
 * Deep link into Grafana Explore on the tenant's regional Loki, showing the
 * extraction-error log stream so a developer can read the actual failures.
 * Scoped to one integration (datasource_type) when given, else tenant-wide.
 * Returns null without a base or datasource uid (regional Loki not located).
 *
 * NOTE: logs carry `datasource_type` but NOT the user/internal `class` — that
 * lives only in the scheduling metric — so links filter by integration, the
 * one join key present in both.
 */
export function lokiErrorLogsUrl(
  base: string | null | undefined,
  dsUid: string | null | undefined,
  tenant: string,
  integration?: string | null,
  fromHours = 24,
): string | null {
  const b = trimBase(base);
  if (!b || !dsUid) return null;
  let expr = `{namespace="${tenant}-dp"} |= \`Error extracting data sources\` | json`;
  if (integration) expr += ` | datasource_type=\`${integration}\``;
  const panes = {
    err: {
      datasource: dsUid,
      queries: [{ refId: "A", expr, datasource: { type: "loki", uid: dsUid } }],
      range: { from: `now-${fromHours}h`, to: "now" },
    },
  };
  const params = new URLSearchParams({
    schemaVersion: "1",
    panes: JSON.stringify(panes),
    orgId: "1",
  });
  return `${b}/explore?${params.toString()}`;
}
