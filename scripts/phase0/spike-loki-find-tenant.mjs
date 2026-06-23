#!/usr/bin/env node
/** Which Loki datasource holds a tenant's logs? Run:
 *   node --env-file=.env.local scripts/phase0/spike-loki-find-tenant.mjs [tenant] */
const URL = process.env.GRAFANA_URL?.replace(/\/$/, "");
const TOKEN = process.env.GRAFANA_TOKEN;
const TENANT = process.argv[2] || "bcgprod";
const H = { Authorization: `Bearer ${TOKEN}`, Accept: "application/json" };
async function g(p) { const r = await fetch(`${URL}${p}`, { headers: H }); const t = await r.text(); if (!r.ok) throw new Error(`${r.status}: ${t.slice(0,120)}`); return JSON.parse(t); }
const nowNs = () => `${Date.now()}000000`;
const agoNs = (h) => `${Date.now() - h*3600*1000}000000`;

async function main() {
  const ds = (await g("/api/datasources")).filter((d) => d.type === "loki");
  console.log(`Searching ${ds.length} Loki datasources for tenant "${TENANT}"\n`);
  for (const d of ds) {
    const base = `/api/datasources/proxy/uid/${d.uid}/loki/api/v1`;
    for (const sel of [`{namespace=~"${TENANT}.*"}`, `{label_tenant="${TENANT}"}`]) {
      try {
        const q = `query=${encodeURIComponent(`${sel} |= \`Extracting data source\``)}&start=${agoNs(6)}&end=${nowNs()}&limit=2&direction=backward`;
        const r = await g(`${base}/query_range?${q}`);
        const streams = r?.data?.result ?? [];
        if (streams.length) {
          console.log(`HIT  [${d.name}] uid=${d.uid}  sel=${sel}`);
          console.log(`     labels: ${JSON.stringify(streams[0].stream)}`);
          const line = streams[0].values?.[0]?.[1] ?? "";
          console.log(`     line: ${line.slice(0, 200)}`);
        }
      } catch (e) {
        // 400 = bad selector for this ds; ignore quietly
        if (!/\b400\b/.test(e.message)) console.log(`  [${d.name}] ${sel} -> ${e.message}`);
      }
    }
  }
  console.log("\n(done)");
}
main().catch((e) => { console.error(e); process.exit(1); });
