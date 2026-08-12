import { NextResponse } from "next/server";
import { latestProductDefectReport } from "@/lib/db";

/**
 * The component list for the sidebar, and nothing else.
 *
 * The nav renders on every page, so this deliberately projects three fields per
 * component instead of handing back the report — a `ProductDefectAnalysis`
 * carries ~1300 signals plus every group, strategy and metric series, which is
 * megabytes of JSON the nav would parse and throw away.
 *
 * Returns `[]` rather than an error when no analysis has been run yet: the nav
 * treats "no children" as "render the parent alone", which is the correct
 * outcome for a report that does not exist.
 */
export async function GET() {
  const report = latestProductDefectReport();
  // Reports stored before per-component analysis existed have no `components`
  // key at all, so the runtime value can be undefined despite the type.
  const components = report?.components ?? [];
  const entries = components
    .map((c) => ({ component: c.component, slug: c.slug, defectCount: c.defectCount }))
    .sort((a, b) => b.defectCount - a.defectCount);
  return NextResponse.json(entries);
}
