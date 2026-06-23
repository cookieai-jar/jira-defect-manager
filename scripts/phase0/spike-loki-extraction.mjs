#!/usr/bin/env node
/**
 * Discover how extraction START/FINISH logs are shaped in Loki so we can count
 * actual extractions per tenant/integration. Run:
 *   node --env-file=.env.local scripts/phase0/spike-loki-extraction.mjs [tenant]
 */
const URL = process.env.GRAFANA_URL?.replace(/\/$/, "");
const TOKEN = process.env.GRAFANA_TOKEN;
if (!URL || !TOKEN) { console.error("need GRAFANA_URL + GRAFANA_TOKEN"); process.exit(1); }
const TENANT = process.argv[2] || "bcgprod";
const H = { Authorization: `Bearer ${TOKEN}`, Accept: "application/json" };
// Loki datasource uid (override per region; bcgprod lives in vezalondon).
const DS = process.env.LOKI_DS || "grafanacloud-logs";
const base = `/api/datasources/proxy/uid/${DS}/loki/api/v1`;

async function g(path) {
  const res = await fetch(`${URL}${path}`, { headers: H });
  const t = await res.text();
  if (!res.ok) throw new Error(`${res.status}: ${t.slice(0, 200)}`);
  return JSON.parse(t);
}
const nowNs = () => `${Date.now()}000000`;
const agoNs = (h) => `${Date.now() - h * 3600 * 1000}000000`;

async function range(query, hours = 3, limit = 20) {
  const p = `query=${encodeURIComponent(query)}&start=${agoNs(hours)}&end=${nowNs()}&limit=${limit}&direction=backward`;
  return g(`${base}/query_range?${p}`);
}
async function instant(query, hours = 24) {
  // metric query evaluated at now (count_over_time/sum etc.)
  return g(`${base}/query?query=${encodeURIComponent(query)}&time=${nowNs()}&start=${agoNs(hours)}&end=${nowNs()}`);
}

async function section(t, fn) { console.log(`\n==== ${t} ====`); try { await fn(); } catch (e) { console.log(`  FAILED: ${e.message}`); } }

const LINE = "Extracting data source";

async function findExtractionStreams() {
  // Try tenant-scoped selectors first, then a broad sweep to learn the labels.
  const selectors = [
    `{namespace="${TENANT}-dp"}`, // data plane — where the extractor worker runs
    `{label_tenant="${TENANT}"}`,
    `{namespace="${TENANT}-cp"}`,
    `{namespace=~"${TENANT}.*"}`,
  ];
  for (const sel of selectors) {
    const q = `${sel} |= \`${LINE}\``;
    let r;
    try { r = await range(q, 6, 10); } catch (e) { console.log(`  ${sel}: ${e.message}`); continue; }
    const streams = r?.data?.result ?? [];
    if (streams.length === 0) { console.log(`  ${sel}: 0 streams`); continue; }
    console.log(`  ${sel}: ${streams.length} streams  <-- USING THIS`);
    console.log(`  stream labels: ${JSON.stringify(streams[0].stream)}`);
    const lines = streams.flatMap((s) => (s.values ?? []).map((v) => v[1])).slice(0, 4);
    for (const l of lines) console.log(`    ${l.slice(0, 260)}`);
    return { sel, streams };
  }
  return null;
}

async function main() {
  console.log(`Tenant=${TENANT}  Loki ds=${DS}`);

  await section("A) Loki stream label names", async () => {
    const r = await g(`${base}/labels?start=${agoNs(6)}&end=${nowNs()}`);
    console.log("  " + (r.data ?? []).join(", "));
  });

  let found;
  await section(`B) find streams containing "${LINE}"`, async () => {
    found = await findExtractionStreams();
  });

  if (!found) { console.log("\nNo extraction streams found — adjust line text / datasource."); return; }

  // Parse a line to see the JSON field names (datasource_type, elapsed, etc.)
  await section("C) parsed fields on a FINISH line", async () => {
    const r = await range(`${found.sel} |= \`FINISH - ${LINE}\``, 12, 3);
    const lines = (r?.data?.result ?? []).flatMap((s) => (s.values ?? []).map((v) => v[1]));
    for (const l of lines.slice(0, 2)) {
      try { console.log("  " + JSON.stringify(JSON.parse(l), null, 0).slice(0, 400)); }
      catch { console.log("  (non-JSON) " + l.slice(0, 300)); }
    }
    if (lines.length === 0) console.log("  no FINISH lines in window");
  });

  // Counts over 24h: START, FINISH, and FINISH broken down by datasource_type.
  await section("D) 24h counts (START / FINISH) for this tenant", async () => {
    const start = await instant(`sum(count_over_time(${found.sel} |= \`START - ${LINE}\` [24h]))`);
    const finish = await instant(`sum(count_over_time(${found.sel} |= \`FINISH - ${LINE}\` [24h]))`);
    const val = (x) => x?.data?.result?.[0]?.value?.[1] ?? "0";
    console.log(`  START=${val(start)}  FINISH=${val(finish)}`);
  });

  await section("E) FINISH by datasource_type (top, 24h)", async () => {
    const r = await instant(
      `topk(15, sum by (datasource_type) (count_over_time(${found.sel} |= \`FINISH - ${LINE}\` | json [24h])))`,
    );
    const rows = r?.data?.result ?? [];
    if (rows.length === 0) console.log("  (no datasource_type breakdown — field may differ)");
    for (const row of rows) console.log(`  ${row.metric.datasource_type ?? "?"}: ${row.value?.[1]}`);
  });
}
main().catch((e) => { console.error(e); process.exit(1); });
