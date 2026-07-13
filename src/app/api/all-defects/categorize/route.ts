import { NextResponse } from "next/server";
import {
  getConfigValue,
  listIssues,
  recordDefectSnapshot,
  setConfigValue,
} from "@/lib/db";
import { categorizeDefects } from "@/lib/defect-categorize";
import type { DefectCategorization } from "@/lib/defect-categorize-core";

export const dynamic = "force-dynamic";

const KV_KEY = "alldefects-categorization";

/** Return the persisted categorization (or null if never run). */
export async function GET() {
  const raw = getConfigValue(KV_KEY);
  if (!raw) return NextResponse.json({ categorization: null });
  try {
    return NextResponse.json({ categorization: JSON.parse(raw) as DefectCategorization });
  } catch {
    return NextResponse.json({ categorization: null });
  }
}

/** Run categorization over the current open All Defects tickets and persist it. */
export async function POST() {
  const issues = listIssues("alldefects");
  if (issues.length === 0) {
    return NextResponse.json({ error: "No All Defects tickets to categorize. Sync first." }, {
      status: 400,
    });
  }
  const now = new Date().toISOString();
  const categorization = await categorizeDefects(issues, { now });
  setConfigValue(KV_KEY, JSON.stringify(categorization));
  // Record today's category distribution for the tile trend (category can't be
  // reconstructed historically — it accrues from each analysis run).
  recordDefectSnapshot(
    now.slice(0, 10),
    categorization.categories.map((c) => ({ grp: "category", key: c.name, count: c.count })),
  );
  return NextResponse.json({ categorization });
}
