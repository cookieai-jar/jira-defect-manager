"use client";

import { Button } from "@/components/ui/button";
import { FileDown } from "lucide-react";
import type { IntegrationsAnalysis } from "@/types/integrations";
import { buildConfluenceHtml } from "@/lib/integrations-confluence-export";

interface Props {
  report: IntegrationsAnalysis;
  jiraBaseUrl: string;
}

/**
 * Exports the full Strategic Integrations analysis as a rich-text HTML file
 * formatted for Confluence. Open the downloaded file in a browser, Select-All →
 * Copy, then paste into a Confluence page — headings, tables, lists, and all
 * JIRA links (ticket + JQL search) are preserved.
 */
export function IntegrationsExportButton({ report, jiraBaseUrl }: Props) {
  function exportHtml() {
    const html = buildConfluenceHtml(report, jiraBaseUrl);
    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const stamp = new Date(report.generatedAt).toISOString().slice(0, 10);
    const a = document.createElement("a");
    a.href = url;
    a.download = `integrations-hardening-${stamp}.html`;
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
