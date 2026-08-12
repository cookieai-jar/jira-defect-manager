import type {
  ComponentAnalysis,
  DefectGroup,
  DefectMetric,
  DetectionStage,
  PreventionStrategy,
  ProductDefectAnalysis,
  TeamActionPlan,
} from "@/types/product-defects";
import { DETECTION_STAGE_LABELS, DISCIPLINE_LABELS, PREVENTION_DISCIPLINES } from "@/types/product-defects";
import { badge, confluenceDocShell, escapeHtml, jiraQueryLink, mdToHtml } from "@/lib/confluence-html";

/**
 * Builds the Product Defect Analysis as a self-contained, Confluence-pasteable
 * HTML document. Mirrors the dashboard's reading order — lead with what is
 * degrading and what to do, then the evidence — so the page argues the same
 * way the app does.
 */

function fmt(v: number | null, unit: string): string {
  if (v == null) return "—";
  const n = Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2);
  const clean = n.includes(".") ? n.replace(/\.?0+$/, "") : n;
  return unit === "%" ? `${clean}%` : clean;
}

/** Direction-aware verdict for a metric's move; empty string when unknowable. */
function verdict(m: DefectMetric): { arrow: string; word: string; color: string } | null {
  if (m.current == null || m.baseline == null) return null;
  const d = m.current - m.baseline;
  const pct = m.baseline === 0 ? null : (d / Math.abs(m.baseline)) * 100;
  if (pct != null && Math.abs(pct) < 1) return { arrow: "→", word: "flat", color: "#6b778c" };
  const improved = m.direction === "down-good" ? d < 0 : d > 0;
  return improved
    ? { arrow: d > 0 ? "↑" : "↓", word: "improving", color: "#216e4e" }
    : { arrow: d > 0 ? "↑" : "↓", word: "worsening", color: "#ae2e24" };
}

function metricsTable(metrics: DefectMetric[]): string {
  const automated = metrics.filter((m) => m.automated);
  if (automated.length === 0) return "";
  const rows = automated
    .map((m) => {
      const v = verdict(m);
      const move = v
        ? `<span style="color:${v.color};font-weight:600">${v.arrow} ${v.word}</span>`
        : '<span style="color:#6b778c">no baseline</span>';
      return `<tr><td>${escapeHtml(m.name)}</td><td>${fmt(m.current, m.unit)}</td><td>${fmt(
        m.baseline,
        m.unit,
      )}</td><td>${move}</td><td style="color:#6b778c;font-size:12px">${escapeHtml(m.unit)}</td></tr>`;
    })
    .join("\n");
  return `<table><thead><tr><th>Metric</th><th>Current</th><th>Baseline</th><th>Trend</th><th>Unit</th></tr></thead><tbody>\n${rows}\n</tbody></table>
<p style="color:#6b778c;font-size:12px">Current = last complete month; baseline = mean of the prior complete months. "Improving"/"worsening" is direction-aware — for a metric like fix-with-test rate, up is good.</p>`;
}

function attentionSection(metrics: DefectMetric[]): string {
  const wrong = metrics
    .filter((m) => m.automated && m.current != null && m.baseline != null && m.baseline !== 0)
    .map((m) => ({ m, pct: ((m.current as number) - (m.baseline as number)) / Math.abs(m.baseline as number) * 100 }))
    .filter(({ m, pct }) => Math.abs(pct) >= 2 && (m.direction === "down-good" ? pct > 0 : pct < 0))
    .sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct));
  if (wrong.length === 0) return "";
  const items = wrong
    .map(
      ({ m, pct }) =>
        `<li><strong>${escapeHtml(m.name)}</strong>: ${fmt(m.baseline, m.unit)} → <strong style="color:#ae2e24">${fmt(
          m.current,
          m.unit,
        )}</strong> (${pct > 0 ? "+" : ""}${Math.round(pct)}%)</li>`,
    )
    .join("\n");
  return `<h2>⚠️ Needs attention — moving the wrong way</h2>\n<ul>\n${items}\n</ul>`;
}

function escapeMatrix(components: ComponentAnalysis[], analyzedTickets: number, signalsByStage: Map<DetectionStage, number>): string {
  if (components.length === 0) return "";
  const stages = [...signalsByStage.entries()]
    .filter(([st]) => st !== "unclassified")
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([st]) => st);
  const header = stages.map((st) => `<th>${escapeHtml(DETECTION_STAGE_LABELS[st])}</th>`).join("");
  const pct = (n: number, total: number) => (total === 0 ? "·" : `${Math.round((100 * n) / total)}%`);
  const baseline = stages
    .map((st) => `<td style="color:#6b778c">${pct(signalsByStage.get(st) ?? 0, analyzedTickets)}</td>`)
    .join("");
  const rows = components
    .map((c) => {
      const byStage = new Map(c.detectionStages.map((d) => [d.stage, d.count]));
      const cells = stages.map((st) => `<td>${pct(byStage.get(st) ?? 0, c.defectCount)}</td>`).join("");
      return `<tr><td><strong>${escapeHtml(c.component)}</strong> · ${c.defectCount}</td>${cells}</tr>`;
    })
    .join("\n");
  return `<h2>Escape signature by component</h2>
<p>Share of each component's defects by the gate that should have caught them. "Unclassified" signals are excluded; components are tags, so rows overlap.</p>
<table><thead><tr><th>Component</th>${header}</tr></thead><tbody>
<tr><td style="color:#6b778c"><em>All defects · ${analyzedTickets}</em></td>${baseline}</tr>
${rows}
</tbody></table>`;
}

function groupSection(g: DefectGroup, jiraBaseUrl: string): string {
  const parts: string[] = [];
  parts.push(
    `<h3>${escapeHtml(g.name)} — ${g.share}% · ${g.ticketCount} defects · sev ${g.severityAvg} · prev ${g.preventabilityAvg}${
      g.regressionCount > 0 ? ` · ${g.regressionCount} regressions` : ""
    }</h3>`,
  );
  if (g.description) parts.push(`<p><em>${escapeHtml(g.description)}</em></p>`);
  if (g.analysis) parts.push(mdToHtml(g.analysis, jiraBaseUrl));
  if (g.escapeAnalysis) {
    parts.push(`<p><strong>Why it escapes:</strong></p>`);
    parts.push(mdToHtml(g.escapeAnalysis, jiraBaseUrl));
  }
  if (g.rootCauses.length) {
    parts.push(
      `<ul>${g.rootCauses
        .map(
          (rc) =>
            `<li><strong>${escapeHtml(rc.title)}</strong>${
              rc.explanation ? ` — ${mdToHtml(rc.explanation, jiraBaseUrl).replace(/^<p>|<\/p>$/g, "")}` : ""
            }</li>`,
        )
        .join("")}</ul>`,
    );
  }
  if (g.subGroups.length) {
    parts.push(
      `<p><strong>Sub-groups:</strong> ${g.subGroups
        .map((s) => `${escapeHtml(s.name)} (${s.ticketCount})`)
        .join(" · ")}</p>`,
    );
  }
  parts.push(`<p>${jiraQueryLink(g.issueKeys, jiraBaseUrl)}</p>`);
  return parts.join("\n");
}

function strategiesSection(strategies: PreventionStrategy[], jiraBaseUrl: string): string {
  if (strategies.length === 0) return "";
  const parts: string[] = [`<h2>Prevention strategies (${strategies.length})</h2>`];
  const rank: Record<string, number> = { now: 0, next: 1, later: 2 };
  for (const d of PREVENTION_DISCIPLINES) {
    const items = strategies
      .filter((s) => s.discipline === d)
      .sort((a, b) => (rank[a.priority] ?? 9) - (rank[b.priority] ?? 9));
    if (items.length === 0) continue;
    parts.push(`<h3>${escapeHtml(DISCIPLINE_LABELS[d])} (${items.length})</h3>`);
    const rows = items
      .map((s) => {
        const detail = s.detail ? mdToHtml(s.detail, jiraBaseUrl) : "";
        const code = s.codeAreas.length
          ? `<br/><span style="color:#6b778c;font-size:12px">Code: ${s.codeAreas.map((a) => `<code>${escapeHtml(a)}</code>`).join(" ")}</span>`
          : "";
        return `<tr><td><strong>${escapeHtml(s.title)}</strong>${detail}${code}</td><td>${escapeHtml(
          s.team,
        )}</td><td>${badge(s.priority)}</td><td>${badge(s.effort)}</td></tr>`;
      })
      .join("\n");
    parts.push(
      `<table><thead><tr><th>Action</th><th>Owner</th><th>Priority</th><th>Effort</th></tr></thead><tbody>\n${rows}\n</tbody></table>`,
    );
  }
  return parts.join("\n");
}

function teamSection(plans: TeamActionPlan[], jiraBaseUrl: string): string {
  if (plans.length === 0) return "";
  const parts: string[] = [`<h2>Team action plans (${plans.length})</h2>`];
  for (const t of plans) {
    const rate =
      t.testChangeRate != null && (t.commitCount ?? 0) >= 5
        ? ` · ${t.testChangeRate}% of fixes touched a test`
        : "";
    parts.push(`<h3>${escapeHtml(t.label)} — ${t.defectCount} defects${rate}</h3>`);
    if (t.summary) parts.push(mdToHtml(t.summary, jiraBaseUrl));
    if (t.topGroups.length) {
      parts.push(
        `<p><strong>Top groups:</strong> ${t.topGroups
          .map((g) => `${escapeHtml(g.name)} (${g.ticketCount})`)
          .join(" · ")}</p>`,
      );
    }
    parts.push(`<p>${jiraQueryLink(t.issueKeys, jiraBaseUrl)}</p>`);
  }
  return parts.join("\n");
}

function componentSection(c: ComponentAnalysis, jiraBaseUrl: string): string {
  const parts: string[] = [];
  parts.push(
    `<h3>${escapeHtml(c.component)} — ${c.defectCount} defects (${c.share}% of population) · sev ${c.severityAvg} · ${c.regressionCount} regressions</h3>`,
  );
  if (c.summary) parts.push(mdToHtml(c.summary, jiraBaseUrl));
  if (c.escapeAnalysis) {
    parts.push(`<p><strong>Why it escapes:</strong></p>`);
    parts.push(mdToHtml(c.escapeAnalysis, jiraBaseUrl));
  }
  if (c.strategies.length) {
    parts.push(
      `<ul>${c.strategies
        .map((s) => `<li>${badge(s.priority)} <strong>${escapeHtml(s.title)}</strong> — ${escapeHtml(s.team)}</li>`)
        .join("")}</ul>`,
    );
  }
  parts.push(`<p>${jiraQueryLink(c.issueKeys, jiraBaseUrl)}</p>`);
  return parts.join("\n");
}

export function buildPdaConfluenceHtml(report: ProductDefectAnalysis, jiraBaseUrl: string): string {
  const generated = new Date(report.generatedAt).toLocaleString();
  const cc = report.codeCorrelation;
  const signalsByStage = new Map<DetectionStage, number>();
  for (const s of report.signals) {
    signalsByStage.set(s.detectionStage, (signalsByStage.get(s.detectionStage) ?? 0) + 1);
  }

  const body: string[] = [];
  body.push(`<h1>Product Defect Analysis</h1>`);
  body.push(
    `<p><em>Analyzed ${escapeHtml(generated)} · ${report.analyzedTickets.toLocaleString()} customer-found defects</em><br/><code style="font-size:11px">${escapeHtml(report.jql)}</code></p>`,
  );

  body.push(
    `<table><thead><tr><th>Defects analyzed</th><th>Defect groups</th><th>Strategies</th><th>Team plans</th><th>Linked to code</th></tr></thead><tbody><tr><td>${
      report.analyzedTickets
    }</td><td>${report.groups.length}</td><td>${report.strategies.length}</td><td>${report.teamPlans.length}</td><td>${
      cc ? `${cc.linkedTickets} (${cc.linkRate}%)` : "—"
    }</td></tr></tbody></table>`,
  );

  body.push(attentionSection(report.metrics));

  body.push(`<h2>Executive summary</h2>`);
  body.push(mdToHtml(report.executiveSummary, jiraBaseUrl));

  body.push(`<h2>Success metrics</h2>`);
  body.push(metricsTable(report.metrics));

  body.push(escapeMatrix(report.components, report.analyzedTickets, signalsByStage));

  body.push(`<h2>Defect groups (${report.groups.length})</h2>`);
  for (const g of report.groups) body.push(groupSection(g, jiraBaseUrl));

  if (cc) {
    body.push(`<h2>Code correlation</h2>`);
    body.push(
      `<p>${cc.linkedTickets} of ${cc.totalTickets} defects (${cc.linkRate}%) link to fix commits in <code>${escapeHtml(
        cc.repoPath,
      )}</code> · ${cc.fixesWithTests} fixes touched a test, ${cc.fixesWithoutTests} did not.</p>`,
    );
    const live = cc.areaHotspots.filter((h) => h.existsAtHead !== false).slice(0, 10);
    if (live.length) {
      body.push(
        `<p><strong>Hottest code areas (distinct defects):</strong></p><ul>${live
          .map(
            (h) =>
              `<li><code>${escapeHtml(h.path)}</code> — ${h.defectCount} defects${
                h.teams.length ? ` · ${escapeHtml(h.teams.join(", "))}` : " · <em>unowned</em>"
              }</li>`,
          )
          .join("")}</ul>`,
      );
    }
  }

  body.push(strategiesSection(report.strategies, jiraBaseUrl));
  body.push(teamSection(report.teamPlans, jiraBaseUrl));

  if (report.components.length) {
    body.push(`<h2>Per-component analysis (${report.components.length})</h2>`);
    for (const c of report.components) body.push(componentSection(c, jiraBaseUrl));
  }

  return confluenceDocShell(`Product Defect Analysis — ${generated}`, body.filter(Boolean).join("\n"));
}
