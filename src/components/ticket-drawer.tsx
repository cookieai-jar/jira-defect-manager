"use client";

import { useEffect, useState } from "react";
import { X, ExternalLink, Loader2 } from "lucide-react";
import type { JiraIssue, TicketAnalysis } from "@/types/triage";
import { TempBadge, Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatDate, daysSince } from "@/lib/utils";

interface Props {
  issueKey: string | null;
  onClose: () => void;
}

export function TicketDrawer({ issueKey, onClose }: Props) {
  const [data, setData] = useState<{ issue: JiraIssue; analysis: TicketAnalysis | null } | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!issueKey) return;
    setLoading(true);
    setData(null);
    fetch(`/api/issues/${issueKey}`)
      .then((r) => r.json())
      .then((d) => setData(d))
      .finally(() => setLoading(false));
  }, [issueKey]);

  if (!issueKey) return null;

  return (
    <div className="fixed inset-0 z-50 flex">
      <button
        aria-label="Close"
        onClick={onClose}
        className="flex-1 bg-black/50 backdrop-blur-sm"
      />
      <div className="w-full max-w-2xl bg-bg border-l border-border-strong flex flex-col h-full">
        <header className="px-5 h-14 border-b border-border flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm font-semibold">{issueKey}</span>
            {data?.issue && (
              <a
                href={data.issue.url}
                target="_blank"
                rel="noreferrer"
                className="text-fg-muted hover:text-accent"
                aria-label="Open in JIRA"
              >
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            )}
          </div>
          <Button variant="ghost" size="sm" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </header>

        <div className="flex-1 overflow-auto scroll-thin">
          {loading ? (
            <div className="p-6 flex items-center gap-2 text-fg-muted text-sm">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
          ) : !data ? (
            <div className="p-6 text-sm text-fg-muted">Not found.</div>
          ) : (
            <div className="p-5 space-y-5">
              <div>
                <h2 className="text-base font-semibold">{data.issue.summary}</h2>
                <div className="flex flex-wrap gap-1.5 mt-2">
                  <Badge>{data.issue.status}</Badge>
                  <Badge>{data.issue.issueType}</Badge>
                  {data.issue.priority && <Badge>{data.issue.priority}</Badge>}
                  {data.analysis && (
                    <>
                      <TempBadge band={data.analysis.temperature} score={data.analysis.temperatureScore} />
                      <Badge>severity {data.analysis.severityScore}/10</Badge>
                      {data.analysis.customer && <Badge>{data.analysis.customer}</Badge>}
                    </>
                  )}
                </div>
                <div className="mt-3 grid grid-cols-2 gap-3 text-xs">
                  <Meta label="Reporter" value={data.issue.reporter ?? "—"} />
                  <Meta label="Assignee" value={data.issue.assignee ?? "—"} />
                  <Meta label="Created" value={formatDate(data.issue.created)} />
                  <Meta
                    label="Last update"
                    value={`${formatDate(data.issue.updated)} (${daysSince(data.issue.updated)}d ago)`}
                  />
                </div>
              </div>

              {data.analysis && (
                <section className="space-y-2">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-muted">
                    Recommendation
                  </h3>
                  <div className="rounded border border-border bg-bg-card p-3 space-y-2">
                    <div className="flex items-center gap-2">
                      <Badge className="border-accent/40 bg-accent/10 text-accent">
                        {data.analysis.recommendation}
                      </Badge>
                      <Badge>{data.analysis.status}</Badge>
                      {data.analysis.suggestedSprint && (
                        <Badge>Sprint {data.analysis.suggestedSprint}</Badge>
                      )}
                    </div>
                    <p className="text-sm text-fg">{data.analysis.rationale}</p>
                    <div className="text-sm">
                      <span className="text-fg-muted">Next step: </span>
                      <span className="text-fg">{data.analysis.nextStep}</span>
                    </div>
                    {data.analysis.evidenceQuotes.length > 0 && (
                      <div className="space-y-1 pt-1">
                        <span className="text-[11px] uppercase tracking-wide text-fg-subtle">
                          Temperature evidence
                        </span>
                        {data.analysis.evidenceQuotes.map((q, i) => (
                          <blockquote
                            key={i}
                            className="border-l-2 border-temperature-hot pl-2 text-xs text-fg-muted italic"
                          >
                            &ldquo;{q}&rdquo;
                          </blockquote>
                        ))}
                      </div>
                    )}
                  </div>
                </section>
              )}

              {data.issue.description && (
                <section className="space-y-2">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-muted">
                    Description
                  </h3>
                  <div className="rounded border border-border bg-bg-card p-3 text-sm whitespace-pre-wrap text-fg-muted max-h-60 overflow-auto scroll-thin">
                    {data.issue.description}
                  </div>
                </section>
              )}

              <section className="space-y-2">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-muted">
                  Recent comments ({data.issue.comments.length})
                </h3>
                <div className="space-y-2">
                  {data.issue.comments.slice(-8).map((c) => (
                    <div key={c.id} className="rounded border border-border bg-bg-card p-3">
                      <div className="flex items-center justify-between text-[11px] text-fg-subtle mb-1">
                        <span className="font-medium text-fg-muted">{c.author}</span>
                        <span>{formatDate(c.created)}</span>
                      </div>
                      <p className="text-sm text-fg whitespace-pre-wrap">{c.body}</p>
                    </div>
                  ))}
                  {data.issue.comments.length === 0 && (
                    <p className="text-xs text-fg-subtle">No comments.</p>
                  )}
                </div>
              </section>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-fg-subtle uppercase tracking-wide text-[10px]">{label}</div>
      <div className="text-fg">{value}</div>
    </div>
  );
}
