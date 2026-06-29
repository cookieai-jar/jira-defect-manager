import { NextResponse } from "next/server";
import { listStarredTenants, starTenant, unstarTenant } from "@/lib/db";
import { isSafeIdentifier } from "@/lib/rca-core";

export const dynamic = "force-dynamic";

/** GET → { starred: string[] } — the user's starred tenant slugs. */
export async function GET() {
  try {
    return NextResponse.json({ starred: listStarredTenants() });
  } catch (err) {
    return NextResponse.json({ starred: [], error: err instanceof Error ? err.message : String(err) }, { status: 200 });
  }
}

/** POST { tenant } → star it. */
export async function POST(req: Request) {
  try {
    const { tenant } = (await req.json()) as { tenant?: string };
    if (!tenant || !isSafeIdentifier(tenant)) {
      return NextResponse.json({ ok: false, error: "invalid tenant" }, { status: 400 });
    }
    starTenant(tenant);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 200 });
  }
}

/** DELETE ?tenant=… → unstar it. */
export async function DELETE(req: Request) {
  const tenant = new URL(req.url).searchParams.get("tenant")?.trim();
  if (!tenant || !isSafeIdentifier(tenant)) {
    return NextResponse.json({ ok: false, error: "invalid tenant" }, { status: 400 });
  }
  try {
    unstarTenant(tenant);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 200 });
  }
}
