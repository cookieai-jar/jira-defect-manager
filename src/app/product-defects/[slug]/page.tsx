import { ProductDefectComponentView } from "@/components/product-defect-component-view";

export default async function ProductDefectComponentPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return <ProductDefectComponentView slug={slug} />;
}
