#!/usr/bin/env node
/**
 * Phase 0 probe: can we get per-tenant extraction/parse ALERTS straight from
 * Grafana (no Slack)? Checks three sources with the existing Grafana token:
 *   A) Alertmanager — currently firing/active alerts + their labels
 *   B) Alert rules — definitions (names/labels), to see extraction/parse rules
 *   C) alert-state-history Loki datasource — firing/resolved transitions w/ labels
 *
 * Run: node --env-file=.env.local scripts/phase0/spike-grafana-alerts.mjs
 */
const URL = process.env.GRAFANA_URL?.replace(/\/$/, "");
const TOKEN = process.env.GRAFANA_TOKEN;
if (!URL || !TOKEN) {
  console.error("Need GRAFANA_URL and GRAFANA_TOKEN in .env.local");
  process.exit(1);
}
const H = { Authorization: `Bearer ${TOKEN}`, Accept: "application/json" };

async function g(path) {
  const res = await fetch(`${URL}${path}`, { headers: H });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${path}: ${text.slice(0, 160)}`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const RELEVANT = /extract|parse|csc|effective|ingest|sync|neo4j|datasource|agent/i;
const labelKeysHistogram = (objs, pick) => {
  const keys = new Set();
  for (const o of objs) for (const k of Object.keys(pick(o) ?? {})) keys.add(k);
  return [...keys].sort();
};

async function tryAlertmanager() {
  console.log(`\n==== A) Alertmanager — active alerts ====`);
  let alerts;
  try {
    alerts = await g(`/api/alertmanager/grafana/api/v2/alerts`);
  } catch (e) {
    console.log(`  active-alerts endpoint failed: ${e.message}`);
    return;
  }
  if (!Array.isArray(alerts)) {
    console.log(`  unexpected shape: ${JSON.stringify(alerts).slice(0, 160)}`);
    return;
  }
  console.log(`  ${alerts.length} active alert instances`);
  const names = {};
  for (const a of alerts) {
    const n = a.labels?.alertname ?? "(unnamed)";
    names[n] = (names[n] ?? 0) + 1;
  }
  const relevantNames = Object.keys(names).filter((n) => RELEVANT.test(n));
  console.log(`  label keys seen across alerts: ${labelKeysHistogram(alerts, (a) => a.labels).join(", ")}`);
  console.log(`  alert names matching ${RELEVANT} (${relevantNames.length}):`);
  for (const n of relevantNames.slice(0, 25)) console.log(`    ${n} x${names[n]}`);
  const sample = alerts.find((a) => RELEVANT.test(a.labels?.alertname ?? "")) ?? alerts[0];
  if (sample) {
    console.log(`  sample relevant alert labels:`);
    console.log("    " + JSON.stringify(sample.labels));
    console.log(`  sample state: ${JSON.stringify(sample.status)}`);
  }
}

async function tryRules() {
  console.log(`\n==== B) Alert rules (definitions) ====`);
  // Prometheus-style rules endpoint lists groups+rules+state; usually viewer-OK.
  let data;
  try {
    data = await g(`/api/prometheus/grafana/api/v1/rules`);
  } catch (e) {
    console.log(`  rules endpoint failed: ${e.message}`);
    return;
  }
  const groups = data?.data?.groups ?? [];
  const rules = groups.flatMap((grp) => (grp.rules ?? []).map((r) => ({ grp: grp.name, ...r })));
  console.log(`  ${groups.length} groups, ${rules.length} rules total`);
  const relevant = rules.filter((r) => RELEVANT.test(r.name ?? "") || RELEVANT.test(JSON.stringify(r.labels ?? {})));
  console.log(`  rules matching ${RELEVANT} (${relevant.length}):`);
  for (const r of relevant.slice(0, 25)) {
    console.log(`    [${r.state ?? r.health ?? "?"}] ${r.name}  labels=${JSON.stringify(r.labels ?? {})}`);
  }
}

async function tryStateHistory() {
  console.log(`\n==== C) alert-state-history (Loki) ====`);
  const uid = "grafanacloud-alert-state-history";
  const base = `/api/datasources/proxy/uid/${uid}/loki/api/v1`;
  let labels;
  try {
    labels = await g(`${base}/labels`);
  } catch (e) {
    console.log(`  labels failed: ${e.message}`);
    return;
  }
  console.log(`  stream labels available: ${(labels?.data ?? []).join(", ")}`);

  const endNs = `${Date.now()}000000`;
  const startNs = `${Date.now() - 24 * 3600 * 1000}000000`;
  // Build a permissive selector from a known label, falling back to from="state-history".
  const selectorLabel = (labels?.data ?? []).includes("from") ? `{from="state-history"}` : null;
  const candidates = [selectorLabel, `{orgID=~".+"}`, `{folderUID=~".+"}`].filter(Boolean);

  for (const sel of candidates) {
    try {
      const q = `${base}/query_range?query=${encodeURIComponent(sel)}&start=${startNs}&end=${endNs}&limit=10&direction=backward`;
      const r = await g(q);
      const streams = r?.data?.result ?? [];
      if (streams.length === 0) {
        console.log(`  selector ${sel}: 0 streams in last 24h`);
        continue;
      }
      console.log(`  selector ${sel}: ${streams.length} streams; sample entries:`);
      const entries = streams.flatMap((s) => (s.values ?? []).map((v) => v[1])).slice(0, 5);
      for (const line of entries) {
        try {
          const j = JSON.parse(line);
          // Grafana state-history line: { schemaVersion, current, previous, labels:{...}, values:{...}, ... }
          console.log(
            `    current=${j.current} prev=${j.previous} rule=${j.labels?.alertname ?? j.ruleTitle ?? "?"} ` +
              `tenant=${j.labels?.tenant_id ?? j.labels?.namespace ?? "-"} labels=${JSON.stringify(j.labels ?? {}).slice(0, 200)}`,
          );
        } catch {
          console.log(`    ${line.slice(0, 200)}`);
        }
      }
      return; // got data, stop trying selectors
    } catch (e) {
      console.log(`  selector ${sel} failed: ${e.message}`);
    }
  }
}

async function main() {
  console.log(`Grafana: ${URL}`);
  await tryAlertmanager();
  await tryRules();
  await tryStateHistory();
  console.log(`\nDone. Goal: confirm extraction/parse alerts carry tenant_id/namespace + agent_type labels.`);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
