"use client";

import { Button } from "@/components/ui/button";
import { FileDown } from "lucide-react";
import type { ProductDefectAnalysis } from "@/types/product-defects";
import { buildPdaConfluenceHtml } from "@/lib/product-defects-confluence-export";

/**
 * Exports the Product Defect Analysis as a rich-text HTML file formatted for
 * Confluence — same workflow as the Integrations export: open the downloaded
 * file in a browser, Select-All → Copy, paste into a Confluence page. Headings,
 * tables, the escape matrix and all JIRA links (ticket + JQL search) survive.
 */
export function ProductDefectsExportButton({
  report,
  jiraBaseUrl,
}: {
  report: ProductDefectAnalysis;
  jiraBaseUrl: string;
}) {
  function exportHtml() {
    const html = buildPdaConfluenceHtml(report, jiraBaseUrl);
    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const stamp = new Date(report.generatedAt).toISOString().slice(0, 10);
    const a = document.createElement("a");
    a.href = url;
    a.download = `product-defect-analysis-${stamp}.html`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <Button
      variant="secondary"
      onClick={exportHtml}
      title="Download a rich-text HTML file to paste into Confluence"
    >
      <FileDown className="h-3.5 w-3.5" />
      Export for Confluence
    </Button>
  );
}
