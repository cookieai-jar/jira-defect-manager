import type {
  HardeningStep,
  IntegrationInsight,
  IntegrationsAnalysis,
  IssueCategory,
} from "@/types/integrations";
import { buildDistribution, type IntegrationDistribution } from "@/lib/strategic-integrations";
import { badge, confluenceDocShell, escapeHtml, jiraQueryLink, mdToHtml } from "@/lib/confluence-html";

/**
 * Builds a self-contained, rich-text HTML document of the Strategic
 * Integrations analysis, formatted for pasting into a Confluence page.
 *
 * The workflow: download the file, open it in a browser, Select-All → Copy,
 * then paste into the Confluence editor. Confluence preserves the headings,
 * tables, lists, and — crucially — every hyperlink, including JIRA ticket
 * links and the `key in (...)` JQL search links used throughout the dashboard.
 */

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

  return confluenceDocShell(`Integrations Hardening — ${generated}`, body.join("\n"));
}
