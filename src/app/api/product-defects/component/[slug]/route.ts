import { NextResponse } from "next/server";
import { getConfig } from "@/lib/config";
import { latestProductDefectReport, listProductDefectIssues } from "@/lib/db";

/**
 * One component's slice of the latest report.
 *
 * `ComponentGroupSlice` is a reference into the parent report (it carries only
 * `groupKey`/`name`/counts), so the page cannot show a group's analysis, escape
 * analysis or root causes from the slice alone. This route joins the parent
 * `DefectGroup` objects the component actually references — not all of them —
 * and narrows the cached ticket store to this component's keys.
 *
 * `analyzedTickets`, `componentDefectSum` and `minDefects` are included because
 * a `ComponentAnalysis` records neither its own denominator nor the threshold it
 * had to clear: without them the page could only print a bare "42%" and could
 * not be honest that components are tags whose counts overlap, nor that
 * lower-volume components have no page at all.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const jiraBaseUrl = process.env.JIRA_BASE_URL?.replace(/\/$/, "") ?? "";

  const report = latestProductDefectReport();
  if (!report) {
    return NextResponse.json({ error: "No product defect analysis has been run yet." }, { status: 404 });
  }

  // Older stored reports predate per-component analysis and have no key here.
  const components = report.components ?? [];
  const component = components.find((c) => c.slug === slug) ?? null;
  if (!component) {
    return NextResponse.json(
      { error: `No analysis for component "${slug}" in the latest report.` },
      { status: 404 },
    );
  }

  const referenced = new Set(component.groups.map((g) => g.groupKey));
  const groups = report.groups.filter((g) => referenced.has(g.key));

  const keys = new Set(component.issueKeys);
  const issues = listProductDefectIssues().filter((i) => keys.has(i.key));

  return NextResponse.json({
    component,
    groups,
    issues,
    jiraBaseUrl,
    analyzedTickets: report.analyzedTickets,
    componentDefectSum: components.reduce((n, c) => n + c.defectCount, 0),
    componentCount: components.length,
    // The qualifying bar, so the page can say why only some components appear.
    minDefects: getConfig().pdaComponentMinDefects,
  });
}
