import { NextResponse } from "next/server";
import { getConfig } from "@/lib/config";
import {
  getConfigValue,
  hasDefectSnapshot,
  listDefectSnapshots,
  listIssues,
  pruneDefectSnapshots,
  recordDefectSnapshot,
  setConfigValue,
} from "@/lib/db";
import { searchIssues } from "@/lib/jira";
import {
  distribution,
  lastNDays,
  pivotTrends,
  reconstructDay,
} from "@/lib/defect-trends-core";

export const dynamic = "force-dynamic";

const WINDOW_DAYS = 90;
const BACKFILL_MARKER = "alldefects-trends-backfilled";

/** Drop a `statusCategory/status != Done` (or NOT IN (Done)) clause so the query includes resolved tickets. */
function toHistoryJql(jql: string): string | null {
  const re = /\s+and\s+status(?:category)?\s+(?:!=\s*done|not\s+in\s*\(\s*done\s*\))/i;
  return re.test(jql) ? jql.replace(re, "") : null;
}

export async function GET() {
  const now = Date.now();
  const today = new Date(now).toISOString().slice(0, 10);
  const days = lastNDays(now, WINDOW_DAYS);
  const sinceDay = days[0];

  // 1) Today's forward snapshot (all groups) from the synced open issues — once/day.
  const openIssues = listIssues("alldefects");
  if (openIssues.length > 0 && !hasDefectSnapshot(today, "status")) {
    recordDefectSnapshot(today, distribution(openIssues, now));
  }

  // 2) One-time backfill of past days for the reconstructable groups, from a full
  //    (open + resolved) JIRA history. Best-effort — trends still work without it.
  if (getConfigValue(BACKFILL_MARKER) !== "1") {
    const historyJql = toHistoryJql(getConfig().jqls.alldefects);
    if (historyJql) {
      try {
        const history = await searchIssues(historyJql, 3000);
        for (const day of days) {
          if (day === today) continue; // today is the forward snapshot
          recordDefectSnapshot(day, reconstructDay(history, day));
        }
        setConfigValue(BACKFILL_MARKER, "1");
      } catch (e) {
        console.warn("[all-defects/trends] backfill failed:", e instanceof Error ? e.message : e);
      }
    } else {
      // No strippable status clause — can't reconstruct resolved tickets. Skip
      // backfill permanently; forward snapshots will accrue from today.
      setConfigValue(BACKFILL_MARKER, "1");
    }
  }

  pruneDefectSnapshots(days[0]);
  const trends = pivotTrends(listDefectSnapshots(sinceDay));
  return NextResponse.json({ trends, generatedAt: new Date(now).toISOString(), windowDays: WINDOW_DAYS });
}
