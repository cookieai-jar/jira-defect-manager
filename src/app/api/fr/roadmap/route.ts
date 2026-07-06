import { NextResponse } from "next/server";
import { searchRoadmapIssues } from "@/lib/jira";
import { buildCommittedRoadmap, parseTargetedMonth, type RoadmapIssueInput } from "@/lib/fr-roadmap";

// Live JIRA fetch (committed FRs + their child epics); never statically cached.
export const dynamic = "force-dynamic";
export const maxDuration = 120;

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

export async function GET() {
  const baseUrl = process.env.JIRA_BASE_URL?.replace(/\/$/, "") ?? "";
  try {
    // 1. Integrations-component FRs with a Targeted Month set (parseable ones group
    //    into months; unparseable ones are surfaced by buildCommittedRoadmap as `dropped`).
    const withMonth = await searchRoadmapIssues(
      'project = FR AND component = "Integrations" AND cf[11123] IS NOT EMPTY ORDER BY key',
      2000,
    );
    const committedKeys = withMonth.filter((f) => parseTargetedMonth(f.targetedMonth)).map((f) => f.key);

    // 2. Their child EAC epics (+ dependency links). Batches are independent → run in parallel.
    const batches = chunk(committedKeys, 50).filter((g) => g.length > 0);
    const childGroups = await Promise.all(batches.map((g) => searchRoadmapIssues(`parent in (${g.join(",")})`, 2000)));
    const children: RoadmapIssueInput[] = childGroups.flat();

    // Ping history (best-effort; dynamic import keeps node:sqlite out of the static graph).
    let pingStats = new Map<string, { count: number; lastPingedAt: string }>();
    try {
      pingStats = (await import("@/lib/db")).pingStatsByIssue();
    } catch (e) {
      console.warn("[fr-roadmap] ping stats unavailable:", e instanceof Error ? e.message : e);
    }

    const roadmap = buildCommittedRoadmap(withMonth, children, baseUrl, Date.now(), pingStats);
    return NextResponse.json({ roadmap });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ roadmap: null, error }, { status: 200 });
  }
}
