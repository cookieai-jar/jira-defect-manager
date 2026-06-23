#!/usr/bin/env node
/**
 * Spike: can we read the allowed-value option list for the Customer field
 * (customfield_10044)? That list is the authoritative set of display names to
 * match Grafana tenant slugs against.
 *
 * Run: node --env-file=.env.local scripts/phase0/spike-jira-customer-options.mjs
 */
const baseUrl = process.env.JIRA_BASE_URL?.replace(/\/$/, "");
const email = process.env.JIRA_EMAIL;
const token = process.env.JIRA_API_TOKEN;
const auth = "Basic " + Buffer.from(`${email}:${token}`).toString("base64");
const FIELD = "customfield_10044";

async function jira(path) {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: { Accept: "application/json", Authorization: auth },
  });
  const t = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${path}: ${t.slice(0, 160)}`);
  return JSON.parse(t);
}

async function main() {
  console.log("== A) field contexts ==");
  let contexts;
  try {
    contexts = await jira(`/rest/api/3/field/${FIELD}/context?maxResults=50`);
    console.log(`  ${contexts.values?.length ?? 0} contexts: ${(contexts.values ?? []).map((c) => `${c.id}:${c.name}`).join(", ")}`);
  } catch (e) {
    console.log(`  contexts FAILED: ${e.message}`);
  }

  if (contexts?.values?.length) {
    const ctxId = contexts.values[0].id;
    console.log(`\n== B) options for context ${ctxId} ==`);
    try {
      let start = 0;
      let total = 0;
      const names = [];
      for (;;) {
        const page = await jira(`/rest/api/3/field/${FIELD}/context/${ctxId}/option?maxResults=100&startAt=${start}`);
        for (const o of page.values ?? []) names.push(o.value);
        total = page.total ?? names.length;
        if (page.isLast || (page.values ?? []).length === 0) break;
        start += (page.values ?? []).length;
        if (start > 5000) break;
      }
      console.log(`  ${names.length} options (total=${total}). Sample:`);
      console.log("   " + names.slice(0, 40).join(" | "));
    } catch (e) {
      console.log(`  options FAILED: ${e.message}`);
    }
  }

  // Fallback source: distinct Customer values seen on recent issues.
  console.log(`\n== C) fallback: distinct Customer values on recent issues ==`);
  try {
    const res = await jira(`/rest/api/3/search/jql?jql=${encodeURIComponent(`cf[10044] is not EMPTY ORDER BY updated DESC`)}&fields=${FIELD}&maxResults=100`);
    const set = new Set();
    for (const issue of res.issues ?? []) {
      for (const o of issue.fields?.[FIELD] ?? []) if (o?.value) set.add(o.value);
    }
    console.log(`  ${set.size} distinct from 100 recent issues:`);
    console.log("   " + [...set].slice(0, 40).join(" | "));
  } catch (e) {
    console.log(`  fallback FAILED: ${e.message}`);
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
