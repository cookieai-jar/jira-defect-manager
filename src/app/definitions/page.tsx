import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import { PRIORITIES, PRIORITY_DEFINITIONS } from "@/lib/priority";

const PRIORITY_COLORS: Record<string, string> = {
  P0: "border-danger/50 bg-danger/10 text-danger",
  P1: "border-warning/50 bg-warning/10 text-warning",
  P2: "border-accent/50 bg-accent/10 text-accent",
  P3: "border-success/50 bg-success/10 text-success",
};

export default function DefinitionsPage() {
  return (
    <div className="flex-1 overflow-auto scroll-thin">
      <header className="px-6 h-14 border-b border-border flex items-center justify-between">
        <h1 className="text-lg font-semibold">Priority Definitions/SLAs</h1>
        <span className="text-[11px] text-fg-subtle">
          Used by the customer-dashboard analysis to recommend priority + flag SLA risk
        </span>
      </header>
      <div className="p-6 max-w-5xl space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Priority definitions</CardTitle>
            <span className="text-[11px] text-fg-subtle">Impact-based</span>
          </CardHeader>
          <CardBody className="p-0">
            <table className="w-full text-sm">
              <thead className="text-[11px] uppercase tracking-wide text-fg-subtle border-b border-border">
                <tr>
                  <th className="px-4 py-2 text-left font-medium w-20">Priority</th>
                  <th className="px-4 py-2 text-left font-medium">Definition</th>
                </tr>
              </thead>
              <tbody>
                {PRIORITIES.map((p) => (
                  <tr key={p} className="border-b border-border/60 last:border-0 align-top">
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex items-center justify-center rounded border px-2 py-0.5 text-xs font-mono font-semibold ${PRIORITY_COLORS[p]}`}
                      >
                        {p}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-fg">{PRIORITY_DEFINITIONS[p].impact}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>SLA</CardTitle>
            <span className="text-[11px] text-fg-subtle">
              Used to flag tickets as on-track, at-risk, or late
            </span>
          </CardHeader>
          <CardBody className="p-0">
            <table className="w-full text-sm">
              <thead className="text-[11px] uppercase tracking-wide text-fg-subtle border-b border-border">
                <tr>
                  <th className="px-4 py-2 text-left font-medium w-20">Priority</th>
                  <th className="px-4 py-2 text-left font-medium">Engineering response</th>
                  <th className="px-4 py-2 text-right font-medium w-40">SLA windows</th>
                </tr>
              </thead>
              <tbody>
                {PRIORITIES.map((p) => {
                  const def = PRIORITY_DEFINITIONS[p];
                  return (
                    <tr key={p} className="border-b border-border/60 last:border-0 align-top">
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex items-center justify-center rounded border px-2 py-0.5 text-xs font-mono font-semibold ${PRIORITY_COLORS[p]}`}
                        >
                          {p}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-fg">{def.sla}</td>
                      <td className="px-4 py-3 text-right text-xs font-mono text-fg-muted whitespace-nowrap">
                        <div>
                          Investigate ≤ {def.slaInvestigationDays === 0 ? "immediate" : `${def.slaInvestigationDays}d`}
                        </div>
                        <div>
                          Fix ≤ {def.slaFixDays === null ? "best-effort" : `${def.slaFixDays}d`}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>SLA status interpretation</CardTitle>
          </CardHeader>
          <CardBody className="space-y-2 text-sm">
            <p>
              For each customer-dashboard ticket, the system computes age from the JIRA
              <code className="mx-1 rounded bg-bg-muted border border-border px-1.5 py-0.5 text-xs">created</code>
              date and compares it against the SLA window for the ticket&apos;s current priority:
            </p>
            <ul className="list-disc pl-5 space-y-1 text-fg-muted">
              <li>
                <span className="text-success font-medium">on-track</span> — age is below 80% of the fix window.
              </li>
              <li>
                <span className="text-warning font-medium">at-risk</span> — age is at or above 80% of the fix window.
              </li>
              <li>
                <span className="text-danger font-medium">late</span> — age has exceeded the fix window.
              </li>
              <li>
                <span className="text-fg-muted font-medium">best-effort</span> — P3, or priority is unknown.
              </li>
            </ul>
            <p className="text-fg-muted">
              The analysis also recommends a priority based on the ticket&apos;s actual impact and
              flags whether the current priority should be raised, lowered, or kept.
            </p>
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
