import { NextResponse } from "next/server";
import { deleteP0, listP0, upsertP0 } from "@/lib/db";
import { z } from "zod";

const PatchSchema = z.object({
  name: z.string().min(1).optional(),
  jqlFragment: z.string().min(1).optional(),
  notes: z.string().nullable().optional(),
});

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const existing = listP0().find((c) => c.id === id);
  if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });
  const body = await req.json();
  const parsed = PatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const next = { ...existing, ...parsed.data };
  upsertP0(next);
  return NextResponse.json(next);
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  deleteP0(id);
  return NextResponse.json({ ok: true });
}
