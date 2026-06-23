import { NextResponse } from "next/server";
import { buildFleet } from "@/lib/tenant-health";

// Computed fresh from Grafana on each load; never statically cached.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const report = await buildFleet();
    return NextResponse.json({ report });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ report: null, error }, { status: 200 });
  }
}
