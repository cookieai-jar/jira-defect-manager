import { describe, it, expect } from "vitest";
import { buildPdaConfluenceHtml } from "@/lib/product-defects-confluence-export";
import { emptyProductDefectAnalysis } from "@/lib/product-defects-analysis";
import type { ProductDefectAnalysis } from "@/types/product-defects";

const JIRA = "https://example.atlassian.net";

function makeReport(): ProductDefectAnalysis {
  const base = emptyProductDefectAnalysis(2, 'project = EAC AND "x" = 1');
  return {
    ...base,
    analyzedTickets: 2,
    executiveSummary: "Fixtures miss the **divergent** shape, see EAC-1.",
    signals: [
      {
        issueKey: "EAC-1", area: "Okta", failureMode: "f", symptom: "s", suspectedRootCause: "r",
        triggerCondition: "t", trigger: "data-shape", escapeReason: "e", detectionStage: "integration-test",
        errorSignatures: [], category: "c", subCategory: "sc", isRegression: false,
        customerImpact: "i", severityScore: 5, preventability: 7,
      },
      {
        issueKey: "EAC-2", area: "Graph", failureMode: "f", symptom: "s", suspectedRootCause: "r",
        triggerCondition: "t", trigger: "data-scale", escapeReason: "e", detectionStage: "unclassified",
        errorSignatures: [], category: "c", subCategory: "sc", isRegression: false,
        customerImpact: "i", severityScore: 5, preventability: 7,
      },
    ],
    groups: [
      {
        key: "g1", name: "Ingestion <correctness>", description: "d", issueKeys: ["EAC-1", "EAC-2"],
        ticketCount: 2, share: 100, subGroups: [], rootCauses: [], analysis: "Breaks on `nil` payloads.",
        escapeAnalysis: "Fixtures too small.", topAreas: [], detectionStages: [], triggers: [],
        severityAvg: 5, preventabilityAvg: 7, regressionCount: 0, exampleQuotes: [],
      },
    ],
    metrics: [
      {
        key: "aging", name: "Aging share", definition: "", unit: "%", direction: "down-good",
        source: "jira", automated: true, current: 42.5, baseline: 22.2, target: null,
        cadence: "monthly", series: [], howToMeasure: "", relatedGroupKeys: [],
      },
      {
        key: "fix-with-test-rate", name: "Fix-with-test rate", definition: "", unit: "%", direction: "up-good",
        source: "code", automated: true, current: 88.9, baseline: 75.7, target: null,
        cadence: "monthly", series: [], howToMeasure: "", relatedGroupKeys: [],
      },
    ],
    strategies: [
      {
        key: "s1", title: "Adversarial fixtures", detail: "Do it in `clients/oaa`.", discipline: "integration-test",
        team: "@org/integrations", groupKeys: ["g1"], effort: "high", priority: "now",
        expectedImpact: "big", metricKeys: ["aging"], codeAreas: ["clients/oaa/connectors"],
      },
    ],
    components: [
      {
        component: "Integrations", slug: "integrations", defectCount: 1, share: 50, issueKeys: ["EAC-1"],
        severityAvg: 5, preventabilityAvg: 7, regressionCount: 0,
        detectionStages: [{ stage: "integration-test", count: 1 }], triggers: [], topAreas: [],
        topFailureModes: [], groups: [], summary: "Okta breaks.", escapeAnalysis: "No page-2 fixture.",
        strategies: [], metrics: [], codeCorrelation: null, teams: [],
      },
    ],
  };
}

describe("buildPdaConfluenceHtml", () => {
  const html = buildPdaConfluenceHtml(makeReport(), JIRA);

  it("escapes group names and renders markdown narrative", () => {
    expect(html).toContain("Ingestion &lt;correctness&gt;");
    expect(html).toContain("<strong>divergent</strong>");
    expect(html).toContain("<code>nil</code>");
  });

  it("linkifies bare JIRA keys and emits JQL search links", () => {
    expect(html).toContain(`${JIRA}/browse/EAC-1`);
    expect(html).toContain(`${JIRA}/issues/?jql=`);
  });

  it("leads with the wrong-way metric and knows up-good from down-good", () => {
    // Aging worsened (down-good, up) → in the attention list.
    expect(html).toMatch(/Needs attention[\s\S]*Aging share/);
    // Fix-with-test improved (up-good, up) → must NOT be flagged as attention.
    const attention = html.slice(html.indexOf("Needs attention"), html.indexOf("Executive summary"));
    expect(attention).not.toContain("Fix-with-test rate");
    expect(html).toContain("worsening");
    expect(html).toContain("improving");
  });

  it("excludes unclassified from the escape matrix but keeps real stages", () => {
    // NB: "Defect groups" alone also matches the stats-table header near the
    // top; the "(N)" suffix pins the section heading.
    const matrix = html.slice(html.indexOf("Escape signature"), html.indexOf("Defect groups (1)"));
    expect(matrix).toContain("<th>Integration test</th>");
    // The caption legitimately mentions the word; the COLUMN must not exist.
    expect(matrix).not.toContain("<th>Unclassified</th>");
  });

  it("renders an empty report without throwing", () => {
    const empty = buildPdaConfluenceHtml(emptyProductDefectAnalysis(0, "jql"), JIRA);
    expect(empty).toContain("Product Defect Analysis");
  });
});
