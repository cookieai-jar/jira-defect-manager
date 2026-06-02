import type {
  JiraIssue,
  P0Customer,
  TicketAnalysis,
  P0Summary,
  TriageReport,
  AppConfig,
  TemperatureBand,
  Scope,
  ResolvedTicketRef,
} from "@/types/triage";
import { defaultModel, jsonCompletion } from "./anthropic";
import { daysSince } from "./utils";
import {
  PRIORITY_DEFINITIONS,
  computeSlaStatus,
  priorityChangeFor,
  priorityFromString,
  slaTargetDate,
} from "./priority";

const TEMP_BANDS: TemperatureBand[] = ["cold", "cool", "warm", "hot", "critical"];

function bandForScore(score: number): TemperatureBand {
  if (score <= 2) return "cold";
  if (score <= 4) return "cool";
  if (score <= 6) return "warm";
  if (score <= 8) return "hot";
  return "critical";
}

function compactIssue(issue: JiraIssue): string {
  const lastComments = issue.comments.slice(-5).map((c) => ({
    author: c.author,
    when: c.created.slice(0, 10),
    body: c.body.slice(0, 1200),
  }));
  return JSON.stringify(
    {
      key: issue.key,
      summary: issue.summary,
      status: issue.status,
      statusCategory: issue.statusCategory,
      priority: issue.priority,
      issueType: issue.issueType,
      reporter: issue.reporter,
      assignee: issue.assignee,
      created: issue.created,
      updated: issue.updated,
      daysSinceUpdate: daysSince(issue.updated),
      resolved: issue.resolved,
      labels: issue.labels,
      components: issue.components,
      description: issue.description?.slice(0, 1500) ?? null,
      commentCount: issue.comments.length,
      lastComments,
    },
    null,
    0,
  );
}

const TICKET_SYSTEM_EAC = `You are a customer-success-focused engineering manager triaging JIRA bug/support tickets.

PRIORITY DEFINITIONS (use these to evaluate every ticket):
- P0: ${PRIORITY_DEFINITIONS.P0.impact} SLA: ${PRIORITY_DEFINITIONS.P0.sla}
- P1: ${PRIORITY_DEFINITIONS.P1.impact} SLA: ${PRIORITY_DEFINITIONS.P1.sla}
- P2: ${PRIORITY_DEFINITIONS.P2.impact} SLA: ${PRIORITY_DEFINITIONS.P2.sla}
- P3: ${PRIORITY_DEFINITIONS.P3.impact} SLA: ${PRIORITY_DEFINITIONS.P3.sla}

For each ticket, output one JSON object with these fields:

- issueKey: string (echo)
- severityScore: integer 1-10. Combine business impact, blast radius, priority field, and customer urgency from comments.
- temperatureScore: integer 1-10. Read the tone of the last few comments — frustration, escalation, churn risk, urgency words drive this UP. Politeness and patience drive it DOWN.
- customer: best-effort customer/account name inferred from labels/components/comments/title, or null if unclear.
- status: one of "active" | "stalled" | "blocked" | "ready-to-close" | "resolved".
   * "ready-to-close" if the last few comments suggest resolution but ticket is still open, OR if no activity for a long time and the issue appears stale.
   * "stalled" if no progress for a while but still relevant.
   * "blocked" if waiting on someone (customer, third party, dependency).
   * "active" if there's recent meaningful progress.
   * "resolved" only if statusCategory == done.
- recommendation: one of "close" | "ping-reporter" | "ping-assignee" | "escalate" | "continue" | "schedule".
   * "close" — issue appears resolved or dead.
   * "ping-reporter" — need info from the reporter to move forward.
   * "ping-assignee" — assignee has gone silent and ticket is sitting.
   * "escalate" — customer is hot/critical and needs management attention.
   * "continue" — work is progressing, no intervention needed.
   * "schedule" — needs to be planned into a sprint.
- rationale: 1-2 sentences explaining the recommendation. Reference specific signals.
- nextStep: One concrete action the EM should take this week, aligned with the recommended priority's SLA window.
- suggestedSprint: 1 (this sprint), 2 (next sprint), or null (backlog / longer).
- evidenceQuotes: array of 0-3 short verbatim quotes (<=140 chars each) from comments that justify the temperature read. Empty array if no comments.
- recommendedPriority: one of "P0" | "P1" | "P2" | "P3" — the priority the ticket SHOULD be at based on the definitions above and what the ticket actually describes. Read the description, comments, severity, and workaround availability to choose.
- priorityRationale: 1 short sentence (<=180 chars) explaining why the recommended priority is appropriate. Reference concrete signals from the ticket.

Return ONLY a JSON array of these objects inside a \`\`\`json fence. No prose.`;

const TICKET_SYSTEM_FR = `You are a product engineering manager triaging JIRA Feature Request (FR) tickets.
These are customer-driven product asks, not bugs. Frame everything around product delivery, not fix turnaround.

For each ticket, output one JSON object with these fields:

- issueKey: string (echo)
- severityScore: integer 1-10. This is the BUSINESS VALUE / CUSTOMER IMPACT of the FR. Higher = more strategic to the company (broad applicability, larger revenue at stake, alignment with stated product direction, tied to expansion or competitive deal). Niche one-off asks or workarounds are lower.
- temperatureScore: integer 1-10. This is CUSTOMER DEMAND INTENSITY for the FR. Higher = customer is pushing hard (repeated follow-ups, escalation language, executive sponsorship on either side, tied to renewal or churn risk). Lower = casual nice-to-have, no recent pressure.
- customer: best-effort customer/account name from labels/components/comments/title, or null if unclear.
- status: one of "active" | "stalled" | "blocked" | "ready-to-close" | "resolved".
   * "active" = recent product motion (PRD updates, scoping, design work, eng investigation, decisions made).
   * "stalled" = no recent activity but the FR still appears relevant.
   * "blocked" = waiting on PRD, design, scoping, leadership approval, eng capacity, dependent FR, or customer clarification.
   * "ready-to-close" = looks like it should be declined, deferred indefinitely, or has been silently shipped/superseded by another FR.
   * "resolved" = statusCategory == done.
- recommendation: one of "close" | "ping-reporter" | "ping-assignee" | "escalate" | "continue" | "schedule".
   * "close" — decline the FR or archive (no longer relevant, superseded, duplicate, or won't-do).
   * "ping-reporter" — need clarification or fresh validation from the requestor/customer.
   * "ping-assignee" — the PM or eng owner has gone silent on a live FR.
   * "escalate" — high-value FR with strong customer demand that is not getting product leadership attention.
   * "continue" — product/eng motion is happening, no intervention needed.
   * "schedule" — needs explicit placement on the product roadmap.
- rationale: 1-2 sentences. Reference specific FR signals — strategic fit, customer asks, exec sponsors, deal value, roadmap alignment.
- nextStep: One concrete product action the EM should take this week (e.g. "loop in PM for scoping", "schedule PRD review", "ask customer for use-case examples").
- suggestedSprint: 1 (this sprint), 2 (next sprint), or null (later roadmap / backlog).
- evidenceQuotes: array of 0-3 short verbatim quotes (<=140 chars each) from comments backing the demand read. Empty array if no comments.

Return ONLY a JSON array of these objects inside a \`\`\`json fence. No prose.`;

const TICKET_SYSTEM_SEC = `You are a security-focused engineering manager triaging JIRA security and PII tickets.
For each ticket, output one JSON object with these fields:

- issueKey: string (echo)
- severityScore: integer 1-10. Map roughly to CVSS-style risk: combine likelihood of exploitation (auth required? remote? prereqs?) with impact (data exposure scope, sensitive data classes like PII / credentials / tokens, blast radius, regulatory exposure). 9-10 = active exploitation, broad PII leak, RCE on prod. 1-3 = theoretical, low-impact, well-mitigated.
- temperatureScore: integer 1-10. URGENCY pressure on the team: external disclosure clock, customer-facing exposure, regulator/legal involvement, executive escalation, public CVE assigned, or coordinated-disclosure deadline drive this UP. Internal-only, no time pressure drives it DOWN.
- customer: best-effort customer/account name from labels/components/title if the issue affects a specific tenant; null otherwise (most security issues are cross-tenant).
- status: one of "active" | "stalled" | "blocked" | "ready-to-close" | "resolved".
   * "active" = recent investigation / patching / mitigation progress.
   * "stalled" = no progress for a while but still unresolved.
   * "blocked" = waiting on a third party (vendor patch, customer info, security review, legal review).
   * "ready-to-close" = the vuln looks mitigated or determined to be a false positive but the ticket is still open.
   * "resolved" = statusCategory == done.
- recommendation: one of "close" | "ping-reporter" | "ping-assignee" | "escalate" | "continue" | "schedule".
   * "close" — false positive, accepted risk, or duplicate.
   * "ping-reporter" — need repro / scope clarification from the reporter or external researcher.
   * "ping-assignee" — assignee has gone silent on an open vulnerability.
   * "escalate" — high severity AND high urgency: PII at risk, active exploit, public disclosure clock, regulator involved.
   * "continue" — investigation / remediation is in motion.
   * "schedule" — needs to be planned into the security sprint or hardening backlog.
- rationale: 1-2 sentences. Reference concrete signals: data class, exploitability, public disclosure, regulatory clock, sensitive endpoint, etc.
- nextStep: One concrete security action (e.g. "rotate exposed credentials", "request CVE", "patch dependency to X.Y.Z", "ask reporter for HTTP repro").
- suggestedSprint: 1 (this sprint), 2 (next sprint), or null (later / hardening backlog).
- evidenceQuotes: array of 0-3 short verbatim quotes (<=140 chars each) from comments backing the urgency read.

Return ONLY a JSON array of these objects inside a \`\`\`json fence. No prose.`;

function ticketSystem(scope: Scope): string {
  if (scope === "fr") return TICKET_SYSTEM_FR;
  if (scope === "sec") return TICKET_SYSTEM_SEC;
  return TICKET_SYSTEM_EAC;
}

interface RawTicketAnalysis {
  issueKey: string;
  severityScore: number;
  temperatureScore: number;
  customer: string | null;
  status: TicketAnalysis["status"];
  recommendation: TicketAnalysis["recommendation"];
  rationale: string;
  nextStep: string;
  suggestedSprint: 1 | 2 | null;
  evidenceQuotes: string[];
  recommendedPriority?: string | null;
  priorityRationale?: string;
}

async function analyzeBatch(
  batch: JiraIssue[],
  model: string,
  p0Names: Set<string>,
  p0Customers: P0Customer[],
  scope: Scope,
): Promise<TicketAnalysis[]> {
  const whiteGloveContext =
    p0Customers.length > 0
      ? `\n\nKNOWN WHITE-GLOVE CUSTOMERS — when the ticket relates to one of these accounts (based on Customer field references, account names in comments/description/labels, or the JQL hints below), set "customer" to the EXACT canonical name from the list. Otherwise return your best-effort customer name or null.

${p0Customers
  .map((c) => `- "${c.name}" — JQL hint: ${c.jqlFragment}`)
  .join("\n")}`
      : "";
  const user = `Analyze the following ${batch.length} JIRA ${scope === "fr" ? "feature request" : "support"} tickets. Today is ${new Date().toISOString().slice(0, 10)}.${whiteGloveContext}

${batch.map((i) => compactIssue(i)).join("\n---\n")}`;

  const raw = await jsonCompletion<RawTicketAnalysis[]>({
    model,
    system: ticketSystem(scope),
    user,
    systemCacheable: true,
    maxTokens: 8000,
  });

  return batch.map((issue) => {
    const r = raw.find((x) => x.issueKey === issue.key);
    const sev = clamp(r?.severityScore ?? 5, 1, 10);
    const tempScore = clamp(r?.temperatureScore ?? 5, 1, 10);
    const customer = r?.customer ?? null;
    const currentPriority = priorityFromString(issue.priority);
    const recommendedPriority =
      scope === "eac" ? priorityFromString(r?.recommendedPriority ?? null) : null;
    const priorityChange =
      scope === "eac" ? priorityChangeFor(currentPriority, recommendedPriority) : null;
    const slaStatus =
      scope === "eac" ? computeSlaStatus(currentPriority, issue.created) : null;
    const slaTarget =
      scope === "eac" ? slaTargetDate(currentPriority, issue.created) : null;
    return {
      issueKey: issue.key,
      severityScore: sev,
      temperatureScore: tempScore,
      temperature: bandForScore(tempScore),
      customer,
      isP0Customer: customer ? p0Names.has(customer.toLowerCase().trim()) : false,
      status: r?.status ?? "active",
      daysSinceUpdate: daysSince(issue.updated),
      recommendation: r?.recommendation ?? "continue",
      rationale: r?.rationale ?? "",
      nextStep: r?.nextStep ?? "",
      suggestedSprint: r?.suggestedSprint ?? null,
      evidenceQuotes: (r?.evidenceQuotes ?? []).slice(0, 3),
      currentPriority,
      recommendedPriority,
      priorityChange,
      priorityRationale: r?.priorityRationale ?? "",
      slaStatus,
      slaTargetDate: slaTarget,
    };
  });
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

function asMarkdown(v: unknown): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) {
    return v
      .map((x) => (typeof x === "string" ? x : JSON.stringify(x)))
      .filter(Boolean)
      .join("\n");
  }
  if (v == null) return "";
  return String(v);
}

const P0_SYSTEM_EAC = `You are an engineering manager writing the weekly status update for a white-glove customer (a hand-picked priority account).
Given the customer's open JIRA support tickets, write a focused, factual status doc.

CRITICAL RULES:
- weeklyProgress must contain EXACTLY ONE BULLET per ticket. NEVER list the
  same ticket key in two separate bullets — consolidate ALL updates for that
  ticket into a single bullet, even if there were multiple separate events
  this week. Walk through every ticket once and only once.

  BAD (do not do this):
    - **EAC-62760**: Customer escalated on Monday.
    - **EAC-62760**: Engineering replied on Tuesday with a fix plan.

  GOOD (do this):
    - **EAC-62760**: Customer escalated Monday; Engineering replied Tuesday
      with a fix plan targeting end of week.

- dailyTracker must contain EXACTLY ONE CHECKBOX per ticket.
- blockers must be a deduplicated array of distinct blocking reasons. Do not
  list the same blocker twice with different wording.

Output one JSON object with these fields, all in GitHub-flavored markdown:

- weeklyProgress: One bullet per ticket (max 10 tickets), ORDERED BY CURRENT
  PRIORITY DESCENDING (P0 first, then P1, P2, P3 — use the ticket's
  current "priority" field). Lead each bullet with the ticket key bolded,
  IMMEDIATELY followed by inline tags for the current priority and current
  status: \`[Pn]\` and \`[<status>]\`. Then a 1-3 sentence consolidated
  summary of what moved this week (or "no movement" if nothing did). Example:
  "- **EAC-61004** [P1] [Under investigation]: Escalated to P1 on 2026-05-18
  after customer pressed for update; reassigning since original investigator
  OOO. Root cause still suspected to be \\$skiptoken invalidation."
- dailyTracker: A markdown checklist with EXACTLY ONE item per ticket. Format:
  "- [ ] <TICKET-KEY> — <one-line action> (owner: <name>)"
- resolutionPlan: A concrete plan (markdown) to fully resolve this customer's
  open issues. Use one "### <TICKET-KEY>" subheading per ticket — never repeat
  a ticket. Include dependencies and an ETA per ticket when inferable.
- blockers: Deduplicated array of distinct blocking reasons across all
  tickets. Combine semantically equivalent blockers into one entry.
- health: "green" | "yellow" | "red". red = at least one critical/hot ticket
  OR multiple stalled tickets OR explicit churn risk in comments.

Return ONLY the JSON inside a \`\`\`json fence.`;

const P0_SYSTEM_FR = `You are a product manager writing the weekly DELIVERY STATUS for a white-glove customer's open feature requests (FRs).
These are customer-driven product asks, not bugs. Frame everything around product delivery (PRD, scoping, design, engineering, roadmap) — NOT bug triage.

CRITICAL RULES:
- weeklyProgress must contain EXACTLY ONE BULLET per FR ticket. NEVER list the
  same ticket key in two separate bullets — consolidate ALL updates for that
  FR into a single bullet.

  BAD (do not do this):
    - **FR-3192**: PM started scoping on Monday.
    - **FR-3192**: Eng raised feasibility concerns Tuesday.

  GOOD (do this):
    - **FR-3192**: PM started scoping Monday; Eng raised feasibility concerns
      Tuesday and is investigating before next PRD revision.

- dailyTracker must contain EXACTLY ONE CHECKBOX per FR.
- blockers must be a deduplicated array of distinct DELIVERY blockers.

Output one JSON object with these fields, all in GitHub-flavored markdown:

- weeklyProgress: One bullet per FR (max 10), ORDERED BY CURRENT PRIORITY
  DESCENDING (P0 first, then P1, P2, P3). Lead with the ticket key bolded,
  IMMEDIATELY followed by inline tags for the current priority and current
  status: \`[Pn]\` and \`[<status>]\`. Then 1-3 sentences on what moved this
  week from a product-delivery standpoint: PRD updates, scoping calls, design
  progress, eng investigation, customer validation, decisions made, roadmap
  placement. Use "no movement this week" when nothing changed. Do NOT frame
  as bug fixes.
- dailyTracker: Checklist with EXACTLY ONE item per FR. Format:
  "- [ ] <TICKET-KEY> — <next product/delivery action> (owner: <PM or eng name>)"
- resolutionPlan: A concrete DELIVERY PLAN in markdown. Use one
  "### <TICKET-KEY>" subheading per FR — never repeat a key. For each FR
  include: target release or quarter if inferable, who owns design vs.
  engineering, dependencies (other FRs, scoping, capacity, approvals),
  and the recommended next milestone.
- blockers: Deduplicated array of distinct delivery blockers across all FRs.
  Examples: "PRD pending PM review", "design capacity constrained until Q4",
  "waiting on customer for use-case examples", "depends on FR-XXXX shipping
  first", "scoping reveals larger effort than estimated".
- health: "green" | "yellow" | "red".
  * red = at least one high-demand FR slipping with no plan, OR a renewal/
    expansion deal is gated on a slipping FR, OR multiple stalled FRs from
    the same customer.
  * yellow = some FRs need attention but no immediate revenue risk.
  * green = clear path to delivery on all open FRs.

Return ONLY the JSON inside a \`\`\`json fence.`;

function p0System(scope: Scope): string {
  return scope === "fr" ? P0_SYSTEM_FR : P0_SYSTEM_EAC;
}

interface RawP0Summary {
  weeklyProgress: unknown;
  dailyTracker: unknown;
  resolutionPlan: unknown;
  blockers?: unknown;
  health: P0Summary["health"];
}

async function summarizeP0(
  customer: P0Customer,
  issues: JiraIssue[],
  model: string,
  scope: Scope,
): Promise<P0Summary> {
  if (issues.length === 0) {
    return {
      customer: customer.name,
      weeklyProgress: "_No open tickets matched._",
      dailyTracker: "_Nothing to track this week._",
      resolutionPlan: "_No open work._",
      openIssueKeys: [],
      blockers: [],
      health: "green",
      generatedAt: new Date().toISOString(),
    };
  }
  const user = `Customer: ${customer.name}
JQL fragment used: ${customer.jqlFragment}
Today: ${new Date().toISOString().slice(0, 10)}

Open tickets (${issues.length}):
${issues.map((i) => compactIssue(i)).join("\n---\n")}`;

  const raw = await jsonCompletion<RawP0Summary>({
    model,
    system: p0System(scope),
    user,
    systemCacheable: true,
    maxTokens: 8000,
  });

  const rawBlockers = Array.isArray(raw.blockers)
    ? raw.blockers.map((b) => (typeof b === "string" ? b : JSON.stringify(b))).filter(Boolean)
    : [];
  // Dedupe blockers case-insensitively while preserving first-seen casing.
  const seen = new Set<string>();
  const blockers: string[] = [];
  for (const b of rawBlockers) {
    const norm = b.toLowerCase().replace(/\s+/g, " ").trim();
    if (norm && !seen.has(norm)) {
      seen.add(norm);
      blockers.push(b.trim());
    }
  }
  return {
    customer: customer.name,
    weeklyProgress: dedupeTicketBullets(asMarkdown(raw.weeklyProgress)),
    dailyTracker: dedupeTicketBullets(asMarkdown(raw.dailyTracker)),
    resolutionPlan: asMarkdown(raw.resolutionPlan),
    openIssueKeys: issues.map((i) => i.key),
    blockers,
    health: raw.health,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Drop duplicate ticket bullets — including all their continuation lines and
 * nested children — when the same JIRA key appears in two list items. The
 * first occurrence wins.
 *
 * Walks line-by-line, tracking indentation. When a list item containing a
 * previously-seen key is found, enters "drop mode" until a list item at the
 * same or shallower indent appears (signaling the next sibling/parent bullet).
 * Handles bullets, numbered lists, checkboxes, multi-line bullets, and
 * nested sub-bullets.
 */
function dedupeTicketBullets(md: string): string {
  if (!md) return md;
  const lines = md.split(/\n/);
  const KEY = /\b([A-Z][A-Z0-9]+-\d+)\b/;
  const LIST_ITEM = /^(\s*)(?:[\-*]|\d+\.)\s/;

  const seen = new Set<string>();
  const out: string[] = [];
  let droppingIndent = -1; // -1 = not dropping

  for (const line of lines) {
    if (droppingIndent >= 0) {
      if (line.trim() === "") {
        // Drop blank lines that sit inside the dropped block.
        continue;
      }
      const itemMatch = line.match(LIST_ITEM);
      if (itemMatch && itemMatch[1].length <= droppingIndent) {
        // Sibling or shallower list item — end of dropped block; fall through.
        droppingIndent = -1;
      } else {
        // Continuation paragraph or nested item — keep dropping.
        continue;
      }
    }

    const itemMatch = line.match(LIST_ITEM);
    if (itemMatch) {
      const keyMatch = line.match(KEY);
      if (keyMatch) {
        const key = keyMatch[1];
        if (seen.has(key)) {
          droppingIndent = itemMatch[1].length;
          continue;
        }
        seen.add(key);
      }
    }
    out.push(line);
  }

  return out.join("\n");
}

export async function runAnalysis(
  issues: JiraIssue[],
  p0Customers: P0Customer[],
  config: AppConfig,
  scope: Scope,
  onProgress?: (event: { phase: string; done: number; total: number }) => void,
  /** Resolved tickets per white-glove customer name, pre-matched by the sync layer. */
  p0ResolvedMap: Map<string, ResolvedTicketRef[]> = new Map(),
): Promise<TriageReport> {
  const model = config.model || defaultModel();
  const p0NameSet = new Set(p0Customers.map((c) => c.name.toLowerCase().trim()));

  // Phase 1: per-ticket analysis in batches of 8 to keep prompts manageable
  const BATCH_SIZE = 8;
  const batches: JiraIssue[][] = [];
  for (let i = 0; i < issues.length; i += BATCH_SIZE) {
    batches.push(issues.slice(i, i + BATCH_SIZE));
  }

  const ticketAnalyses: TicketAnalysis[] = [];
  onProgress?.({ phase: "tickets", done: 0, total: batches.length });
  // Run batches with limited parallelism (3 in flight)
  const inFlight: Promise<void>[] = [];
  let nextIndex = 0;
  const PARALLEL = 3;
  let finished = 0;
  async function worker() {
    while (true) {
      const idx = nextIndex++;
      if (idx >= batches.length) return;
      const res = await analyzeBatch(batches[idx], model, p0NameSet, p0Customers, scope);
      ticketAnalyses.push(...res);
      finished++;
      onProgress?.({ phase: "tickets", done: finished, total: batches.length });
    }
  }
  for (let i = 0; i < Math.min(PARALLEL, batches.length); i++) inFlight.push(worker());
  await Promise.all(inFlight);

  // Canonicalize Claude's customer attribution against the configured
  // white-glove names. We trust Claude to assign the right account from the
  // canonical list provided in the prompt; this step just normalizes casing
  // and sets isP0Customer accordingly.
  const wgByLowerName = new Map<string, P0Customer>();
  for (const c of p0Customers) wgByLowerName.set(c.name.toLowerCase().trim(), c);
  for (const a of ticketAnalyses) {
    if (a.customer) {
      const wg = wgByLowerName.get(a.customer.toLowerCase().trim());
      if (wg) {
        a.customer = wg.name;
        a.isP0Customer = true;
      }
    }
  }

  ticketAnalyses.sort((a, b) => a.issueKey.localeCompare(b.issueKey));

  // Phase 2: P0 customer summaries
  const issuesByKey = new Map(issues.map((i) => [i.key, i]));
  const p0Summaries: P0Summary[] = [];
  onProgress?.({ phase: "p0", done: 0, total: p0Customers.length });
  for (let i = 0; i < p0Customers.length; i++) {
    const customer = p0Customers[i];
    const matched = ticketAnalyses
      .filter(
        (a) =>
          a.customer &&
          a.customer.toLowerCase().trim() === customer.name.toLowerCase().trim() &&
          a.status !== "resolved",
      )
      .map((a) => issuesByKey.get(a.issueKey))
      .filter((x): x is JiraIssue => Boolean(x));
    const resolvedTickets = p0ResolvedMap.get(customer.name) ?? [];
    try {
      const summary = await summarizeP0(customer, matched, model, scope);
      summary.resolvedTickets = resolvedTickets;
      p0Summaries.push(summary);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.warn(`[runAnalysis] P0 summary failed for ${customer.name}:`, errMsg);
      p0Summaries.push({
        customer: customer.name,
        weeklyProgress: `_Summary generation failed: ${errMsg.slice(0, 200)}_`,
        dailyTracker: "_unavailable — see error above_",
        resolutionPlan: "_unavailable — see error above_",
        openIssueKeys: matched.map((m) => m.key),
        resolvedTickets,
        blockers: [],
        health: "yellow",
        generatedAt: new Date().toISOString(),
      });
    }
    onProgress?.({ phase: "p0", done: i + 1, total: p0Customers.length });
  }

  // Derive close + ping candidates from analyses
  const closeCandidates = ticketAnalyses
    .filter(
      (a) =>
        a.recommendation === "close" ||
        (a.status === "ready-to-close") ||
        (a.daysSinceUpdate >= config.inactivityThresholdDays && a.status !== "active"),
    )
    .map((a) => a.issueKey);

  const pingCandidates = ticketAnalyses
    .filter(
      (a) =>
        a.recommendation === "ping-reporter" ||
        a.recommendation === "ping-assignee" ||
        (a.daysSinceUpdate >= config.pingThresholdDays &&
          a.status !== "resolved" &&
          a.recommendation !== "close"),
    )
    .map((a) => ({
      issueKey: a.issueKey,
      target: (a.recommendation === "ping-reporter" ? "reporter" : "assignee") as
        | "reporter"
        | "assignee",
    }));

  return {
    generatedAt: new Date().toISOString(),
    p0Summaries,
    ticketAnalyses,
    closeCandidates,
    pingCandidates,
  };
}

export { TEMP_BANDS };
