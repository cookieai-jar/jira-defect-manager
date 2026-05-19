import { NextResponse } from "next/server";
import { clearRevisitFlag, deleteDecision, getDecision } from "@/lib/db";

export async function DELETE(_req: Request, { params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  deleteDecision(key);
  return NextResponse.json({ ok: true });
}

/**
 * PATCH /api/priority-decisions/<key> with body `{ action: "dismiss-revisit" }`
 * clears the revisit flag without removing the underlying ignore decision.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const body = await req.json().catch(() => ({}));
  if (body?.action === "dismiss-revisit") {
    clearRevisitFlag(key);
    return NextResponse.json({ ok: true });
  }
  const existing = getDecision(key);
  return NextResponse.json(existing ?? { error: "not found" }, {
    status: existing ? 200 : 404,
  });
}
