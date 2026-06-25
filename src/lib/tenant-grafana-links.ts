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
