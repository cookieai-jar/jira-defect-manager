import { TenantHealthDashboard } from "@/components/tenant-health-dashboard";

export default async function TenantDetailPage({
  params,
}: {
  params: Promise<{ tenant: string }>;
}) {
  const { tenant } = await params;
  return <TenantHealthDashboard tenant={decodeURIComponent(tenant)} />;
}
