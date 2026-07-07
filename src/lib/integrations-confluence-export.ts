import type {
  HardeningStep,
  IntegrationInsight,
  IntegrationsAnalysis,
  IssueCategory,
} from "@/types/integrations";
import { buildDistribution, type IntegrationDistribution } from "@/lib/strategic-integrations";

/**
 * Builds a self-contained, rich-text HTML document of the Strategic
 * Integrations analysis, formatted for pasting into a Confluence page.
 *
 * The workflow: download the file, open it in a browser, Select-All → Copy,
 * then paste into the Confluence editor. Confluence preserves the headings,
 * tables, lists, and — crucially — every hyperlink, including JIRA ticket
 * links and the `key in (...)` JQL search links used throughout the dashboard.
 */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** JQL search URL opening all the given tickets at once (mirrors JiraQueryLink). */
function jqlSearchUrl(keys: string[], jiraBaseUrl: string): string | null {
  if (!jiraBaseUrl || keys.length === 0) return null;
  const jql = `key in (${keys.join(",")}) ORDER BY created DESC`;
  return `${jiraBaseUrl}/issues/?jql=${encodeURIComponent(jql)}`;
}

/** A link that opens N tickets in JIRA, or plain text when no base URL. */
function jiraQueryLink(keys: string[], jiraBaseUrl: string, label?: string): string {
  const count = keys.length;
  if (count === 0) return "";
  const text = label ?? `View ${count} ticket${count === 1 ? "" : "s"} in JIRA`;
  const href = jqlSearchUrl(keys, jiraBaseUrl);
  if (!href) return `<span style="color:#6b778c">${count} ticket${count === 1 ? "" : "s"}</span>`;
  return `<a href="${escapeHtml(href)}">${escapeHtml(text)}</a>`;
}

/**
 * Minimal Markdown → HTML for the model-authored narrative fields. Handles the
 * subset the analysis produces: bold, italic, inline code, links, fenced code,
 * unordered/ordered lists, and paragraphs. Bare JIRA keys are linkified.
 */
function mdToHtml(input: unknown, jiraBaseUrl: string): string {
  let text = typeof input === "string" ? input : input == null ? "" : String(input);
  if (!text.trim()) return "";

  // Protect fenced code blocks first.
  const codeBlocks: string[] = [];
  text = text.replace(/```[\s\S]*?```/g, (m) => {
    const body = m.replace(/^```[^\n]*\n?/, "").replace(/```$/, "");
    codeBlocks.push(`<pre><code>${escapeHtml(body)}</code></pre>`);
    return ` §CODE${codeBlocks.length - 1}§ `;
  });

  // Stash inline fragments behind a § sentinel so the bold/italic matchers
  // never touch them and the markers never collide with real digits.
  const inline = (raw: string): string => {
    const slots: string[] = [];
    const stash = (html: string): string => {
      slots.push(html);
      return `§${slots.length - 1}§`;
    };

    // Protect inline code and markdown links before escaping/linkifying.
    let s = raw.replace(/`([^`\n]+)`/g, (_m, c) => stash(`<code>${escapeHtml(c)}</code>`));
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label, url) =>
      stash(`<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`),
    );
    s = escapeHtml(s);

    // Linkify bare JIRA keys (e.g. EAC-61004) → /browse/<key>.
    if (jiraBaseUrl) {
      const KEY = /(?<![\w[(\-/])([A-Z][A-Z0-9]+-\d+)(?![\w\])-])/g;
      s = s.replace(KEY, (_m, key) => stash(`<a href="${jiraBaseUrl}/browse/${key}">${key}</a>`));
    }

    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/(?<!\*)\*(?!\*)([^*\n]+)\*(?!\*)/g, "<em>$1</em>");

    s = s.replace(/§(\d+)§/g, (_m, i) => slots[Number(i)]);
    return s;
  };

  const lines = text.split("\n");
  const out: string[] = [];
  let listType: "ul" | "ol" | null = null;
  let para: string[] = [];

  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${inline(para.join(" "))}</p>`);
      para = [];
    }
  };
  const closeList = () => {
    if (listType) {
      out.push(`</${listType}>`);
      listType = null;
    }
  };

  for (const line of lines) {
    const codePlaceholder = line.match(/^ §CODE(\d+)§ $/);
    if (codePlaceholder) {
      flushPara();
      closeList();
      out.push(codeBlocks[Number(codePlaceholder[1])]);
      continue;
    }
    if (!line.trim()) {
      flushPara();
      closeList();
      continue;
    }
    const ulMatch = line.match(/^\s*[-*+]\s+(.*)$/);
    const olMatch = line.match(/^\s*\d+\.\s+(.*)$/);
    if (ulMatch) {
      flushPara();
      if (listType !== "ul") {
        closeList();
        out.push("<ul>");
        listType = "ul";
      }
      out.push(`<li>${inline(ulMatch[1])}</li>`);
      continue;
    }
    if (olMatch) {
      flushPara();
      if (listType !== "ol") {
        closeList();
        out.push("<ol>");
        listType = "ol";
      }
      out.push(`<li>${inline(olMatch[1])}</li>`);
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushPara();
      closeList();
      const level = Math.min(6, heading[1].length + 2); // keep doc headings dominant
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }
    closeList();
    para.push(line.trim());
  }
  flushPara();
  closeList();

  let html = out.join("\n");
  html = html.replace(/ §CODE(\d+)§ /g, (_m, i) => codeBlocks[Number(i)]);
  return html;
}

function badge(text: string): string {
  return `<span style="display:inline-block;border:1px solid #c1c7d0;border-radius:3px;padding:0 6px;font-size:12px;color:#42526e;background:#f4f5f7;margin-right:4px">${escapeHtml(text)}</span>`;
}

function categorySection(c: IssueCategory, jiraBaseUrl: string): string {
  const parts: string[] = [];
  parts.push(
    `<h3>${escapeHtml(c.name)} — ${c.share}% · ${c.ticketCount} ticket${c.ticketCount === 1 ? "" : "s"}</h3>`,
  );
  if (c.description) parts.push(`<p>${escapeHtml(c.description)}</p>`);
  if (c.topIntegrations.length) {
    parts.push(`<p><strong>Affected:</strong> ${c.topIntegrations.map(badge).join("")}</p>`);
  }
  if (c.rootCauses.length) {
    parts.push("<p><strong>Root causes</strong></p>");
    for (const rc of c.rootCauses) {
      parts.push(`<p>⚠️ <strong>${escapeHtml(rc.title)}</strong></p>`);
      if (rc.explanation) parts.push(mdToHtml(rc.explanation, jiraBaseUrl));
      if (rc.contributingFactors.length) {
        parts.push(
          `<ul>${rc.contributingFactors.map((f) => `<li>${escapeHtml(f)}</li>`).join("")}</ul>`,
        );
      }
      if (rc.issueKeys.length) {
        const link = jiraQueryLink(
          rc.issueKeys,
          jiraBaseUrl,
          `Evidence · ${rc.issueKeys.length} ticket${rc.issueKeys.length === 1 ? "" : "s"} in JIRA`,
        );
        parts.push(`<p>${link}</p>`);
      }
    }
  }
  if (c.exampleQuotes.length) {
    parts.push("<p><strong>Example signals</strong></p>");
    parts.push(
      `<blockquote>${c.exampleQuotes.map((q) => `<p><em>“${escapeHtml(q)}”</em></p>`).join("")}</blockquote>`,
    );
  }
  if (c.issueKeys.length) {
    parts.push(
      `<p><strong>Tickets (${c.issueKeys.length}):</strong> ${jiraQueryLink(c.issueKeys, jiraBaseUrl)}</p>`,
    );
  }
  return parts.join("\n");
}

function hardeningTable(title: string, steps: HardeningStep[], jiraBaseUrl: string): string {
  if (!steps.length) return `<h3>${escapeHtml(title)}</h3><p>No steps recommended.</p>`;
  const rows = steps
    .map((s) => {
      const detail = s.detail ? mdToHtml(s.detail, jiraBaseUrl) : "";
      const addresses = s.category
        ? `<br/><span style="color:#6b778c;font-size:12px">Addresses: ${escapeHtml(s.category)}</span>`
        : "";
      return `<tr><td><strong>${escapeHtml(s.title)}</strong>${detail}${addresses}</td><td>${badge(s.priority)}</td><td>${badge(s.effort)}</td></tr>`;
    })
    .join("\n");
  return `<h3>${escapeHtml(title)} (${steps.length})</h3>
<table><thead><tr><th>Step</th><th>Priority</th><th>Effort</th></tr></thead><tbody>
${rows}
</tbody></table>`;
}

function integrationSection(
  integration: IntegrationDistribution,
  insight: IntegrationInsight | undefined,
  jiraBaseUrl: string,
): string {
  if (integration.total === 0) return "";
  const parts: string[] = [];
  parts.push(
    `<h4>${escapeHtml(integration.label)} — ${integration.total} ticket${integration.total === 1 ? "" : "s"} · ${integration.byCategory.length} categories</h4>`,
  );
  if (insight?.summary) parts.push(mdToHtml(insight.summary, jiraBaseUrl));
  const catInsightByName = new Map((insight?.categoryInsights ?? []).map((ci) => [ci.category, ci]));
  for (const bucket of integration.byCategory) {
    const ci = catInsightByName.get(bucket.category);
    parts.push(
      `<p><strong>${escapeHtml(bucket.category)}</strong> · ${bucket.issueKeys.length} — ${jiraQueryLink(
        bucket.issueKeys,
        jiraBaseUrl,
        `open ${bucket.issueKeys.length} ticket${bucket.issueKeys.length === 1 ? "" : "s"} in JIRA`,
      )}</p>`,
    );
    if (ci?.analysis) parts.push(mdToHtml(ci.analysis, jiraBaseUrl));
    if (ci && ci.actions.length) {
      parts.push(`<ul>${ci.actions.map((a) => `<li>${escapeHtml(a)}</li>`).join("")}</ul>`);
    }
  }
  const allKeys = integration.byCategory.flatMap((b) => b.issueKeys);
  parts.push(`<p>${jiraQueryLink(allKeys, jiraBaseUrl)}</p>`);
  return parts.join("\n");
}

export function buildConfluenceHtml(report: IntegrationsAnalysis, jiraBaseUrl: string): string {
  const insightByKey = new Map(report.integrationInsights.map((i) => [i.key, i]));
  const distribution = buildDistribution(report.signals, report.categories);
  const rootCauseCount = report.categories.reduce((n, c) => n + c.rootCauses.length, 0);
  const hardeningCount = report.developerHardening.length + report.qaHardening.length;
  const generated = new Date(report.generatedAt).toLocaleString();

  const body: string[] = [];
  body.push(`<h1>Integrations Hardening</h1>`);
  body.push(`<p><em>Analyzed ${escapeHtml(generated)}</em></p>`);

  // Summary stats.
  body.push(
    `<table><thead><tr><th>Tickets analyzed</th><th>Issue categories</th><th>Root causes</th><th>Hardening steps</th></tr></thead><tbody><tr><td>${report.analyzedTickets}</td><td>${report.categories.length}</td><td>${rootCauseCount}</td><td>${hardeningCount}</td></tr></tbody></table>`,
  );

  body.push(`<h2>Executive summary</h2>`);
  body.push(mdToHtml(report.executiveSummary, jiraBaseUrl));

  body.push(`<h2>Issue categories</h2>`);
  body.push(`<p>${report.categories.length} found · by volume</p>`);
  for (const c of report.categories) body.push(categorySection(c, jiraBaseUrl));

  body.push(`<h2>Hardening</h2>`);
  body.push(hardeningTable("Developer hardening", report.developerHardening, jiraBaseUrl));
  body.push(hardeningTable("Quality Engineering hardening", report.qaHardening, jiraBaseUrl));

  body.push(`<h2>Distribution &amp; failure analysis by strategic integration</h2>`);
  body.push(
    `<p>${distribution.matched} tickets across strategic integrations${
      distribution.unmatched > 0 ? ` · ${distribution.unmatched} on other integrations` : ""
    }</p>`,
  );
  for (const group of distribution.groups) {
    if (group.total === 0) continue;
    body.push(`<h3>${escapeHtml(group.label)} (${group.total})</h3>`);
    for (const integration of group.integrations) {
      body.push(integrationSection(integration, insightByKey.get(integration.key), jiraBaseUrl));
    }
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>Integrations Hardening — ${escapeHtml(generated)}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #172b4d; line-height: 1.5; max-width: 980px; margin: 24px auto; padding: 0 24px; }
  h1 { font-size: 28px; border-bottom: 2px solid #dfe1e6; padding-bottom: 8px; }
  h2 { font-size: 22px; margin-top: 32px; border-bottom: 1px solid #dfe1e6; padding-bottom: 6px; }
  h3 { font-size: 18px; margin-top: 24px; }
  h4 { font-size: 15px; margin-top: 18px; }
  table { border-collapse: collapse; width: 100%; margin: 12px 0; }
  th, td { border: 1px solid #dfe1e6; padding: 8px 10px; text-align: left; vertical-align: top; }
  th { background: #f4f5f7; }
  blockquote { border-left: 3px solid #dfe1e6; margin: 8px 0; padding-left: 12px; color: #42526e; }
  code { background: #f4f5f7; padding: 1px 4px; border-radius: 3px; font-size: 90%; }
  pre { background: #f4f5f7; padding: 12px; border-radius: 4px; overflow-x: auto; }
  a { color: #0052cc; }
</style>
</head>
<body>
${body.join("\n")}
</body>
</html>`;
}
