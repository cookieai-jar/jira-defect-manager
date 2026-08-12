import { NextResponse } from "next/server";
import { runProductDefectSync } from "@/lib/product-defects-runner";
import {
  getProductDefectsSyncState,
  startProductDefectsSyncState,
} from "@/lib/product-defects-sync-state";

export async function GET() {
  return NextResponse.json(getProductDefectsSyncState());
}

export async function POST() {
  if (getProductDefectsSyncState().running) {
    return NextResponse.json({ error: "sync already running" }, { status: 409 });
  }
  startProductDefectsSyncState();
  // Fire and forget: the run takes tens of minutes over ~1300 tickets, so the
  // client polls GET for progress rather than holding the request open.
  void runProductDefectSync();
  return NextResponse.json({ ok: true, state: getProductDefectsSyncState() }, { status: 202 });
}
