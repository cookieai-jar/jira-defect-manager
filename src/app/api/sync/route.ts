import { NextResponse } from "next/server";
import { getSyncState, mergeSyncState, type SyncRunRow } from "@/lib/sync-state";
import { triggerSync } from "@/lib/sync-runner";
import { latestSyncRun } from "@/lib/db";
import { isScope, type Scope } from "@/types/triage";

function scopeFromReq(req: Request): Scope | null {
  const url = new URL(req.url);
  const s = url.searchParams.get("scope");
  return isScope(s) ? s : null;
}

export async function GET(req: Request) {
  const scope = scopeFromReq(req);
  if (!scope)
    return NextResponse.json({ error: "scope must be 'eac', 'fr', or 'sec'" }, { status: 400 });
  // Merge the DB's latest run so the indicator reflects scheduler/background syncs.
  const merged = mergeSyncState(
    getSyncState(scope),
    latestSyncRun(scope) as SyncRunRow | null,
    Date.now(),
  );
  return NextResponse.json(merged);
}

export async function POST(req: Request) {
  const scope = scopeFromReq(req);
  if (!scope)
    return NextResponse.json({ error: "scope must be 'eac', 'fr', or 'sec'" }, { status: 400 });
  const { started } = triggerSync(scope);
  if (!started) {
    return NextResponse.json({ error: "sync already running" }, { status: 409 });
  }
  return NextResponse.json({ ok: true, state: getSyncState(scope) }, { status: 202 });
}
