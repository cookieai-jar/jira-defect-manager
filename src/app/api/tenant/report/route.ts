import { NextResponse } from "next/server";
import { buildTenantReport } from "@/lib/tenant-health";

// Always computed fresh from Grafana/JIRA; never statically cached.
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const tenant = new URL(req.url).searchParams.get("tenant")?.trim() || "bcgprod";
  try {
    const report = await buildTenantReport(tenant);
    return NextResponse.json({ report });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ report: null, error }, { status: 200 });
  }
}
