import type {
  JiraIssue,
  P0Customer,
  TicketAnalysis,
  P0Summary,
  TriageReport,
  AppConfig,
  TemperatureBand,
} from "@/types/triage";
import { defaultModel, jsonCompletion } from "./anthropic";
import { daysSince } from "./utils";

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

const TICKET_SYSTEM = `You are a customer-success-focused engineering manager triaging JIRA tickets.
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
- nextStep: One concrete action the EM should take this week.
- suggestedSprint: 1 (this sprint), 2 (next sprint), or null (backlog / longer).
- evidenceQuotes: array of 0-3 short verbatim quotes (<=140 chars each) from comments that justify the temperature read. Empty array if no comments.

Return ONLY a JSON array of these objects inside a \`\`\`json fence. No prose.`;

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
}

async function analyzeBatch(
  batch: JiraIssue[],
  model: string,
  p0Names: Set<string>,
): Promise<TicketAnalysis[]> {
  const user = `Analyze the following ${batch.length} JIRA tickets. Today is ${new Date().toISOString().slice(0, 10)}.

${batch.map((i) => compactIssue(i)).join("\n---\n")}`;

  const raw = await jsonCompletion<RawTicketAnalysis[]>({
    model,
    system: TICKET_SYSTEM,
    user,
    systemCacheable: true,
    maxTokens: 6000,
  });

  return batch.map((issue) => {
    const r = raw.find((x) => x.issueKey === issue.key);
    const sev = clamp(r?.severityScore ?? 5, 1, 10);
    const tempScore = clamp(r?.temperatureScore ?? 5, 1, 10);
    const customer = r?.customer ?? null;
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

const P0_SYSTEM = `You are an engineering manager writing the weekly status update for a P0 customer.
Given the customer's open JIRA tickets, write a focused, factual status doc.

Output one JSON object with these fields, all in GitHub-flavored markdown:

- weeklyProgress: A 4-8 bullet markdown summary of what moved this week per ticket. Use ticket keys.
- dailyTracker: A markdown checklist (one item per ticket, max 10) of "What's the next 24-hour action?" Format: "- [ ] <TICKET-KEY> — <one-line action> (owner: <name>)"
- resolutionPlan: A concrete plan (markdown) to fully resolve this customer's open issues. Group by ticket. Include dependencies and an ETA per ticket when inferable.
- blockers: Array of short strings naming blockers across all of this customer's tickets.
- health: "green" | "yellow" | "red". red = at least one critical/hot ticket OR multiple stalled tickets OR explicit churn risk in comments.

Return ONLY the JSON inside a \`\`\`json fence.`;

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
    system: P0_SYSTEM,
    user,
    systemCacheable: true,
    maxTokens: 4000,
  });

  const blockers = Array.isArray(raw.blockers)
    ? raw.blockers.map((b) => (typeof b === "string" ? b : JSON.stringify(b))).filter(Boolean)
    : [];
  return {
    customer: customer.name,
    weeklyProgress: asMarkdown(raw.weeklyProgress),
    dailyTracker: asMarkdown(raw.dailyTracker),
    resolutionPlan: asMarkdown(raw.resolutionPlan),
    openIssueKeys: issues.map((i) => i.key),
    blockers,
    health: raw.health,
    generatedAt: new Date().toISOString(),
  };
}

const PLAN_SYSTEM = `You are an engineering manager building a 2-sprint resolution plan for non-P0 customer tickets.

Output one JSON object:
- plan: markdown with two sections, "## Sprint 1" and "## Sprint 2". Under each, group tickets by theme/component. For each ticket give ticket key, 1-line action, suggested owner if obvious from data, and rough effort (S/M/L).

Return ONLY the JSON inside a \`\`\`json fence.`;

async function generateTwoSprintPlan(
  analyses: TicketAnalysis[],
  issuesByKey: Map<string, JiraIssue>,
  model: string,
): Promise<string> {
  const candidates = analyses
    .filter((a) => !a.isP0Customer && a.recommendation !== "close" && a.suggestedSprint !== null)
    .sort((a, b) => (b.severityScore + b.temperatureScore) - (a.severityScore + a.temperatureScore))
    .slice(0, 60);
  if (candidates.length === 0) {
    return "_No non-P0 tickets need scheduling right now._";
  }
  const payload = candidates.map((a) => {
    const issue = issuesByKey.get(a.issueKey);
    return {
      key: a.issueKey,
      summary: issue?.summary ?? "",
      component: issue?.components ?? [],
      assignee: issue?.assignee ?? null,
      severity: a.severityScore,
      temperature: a.temperatureScore,
      suggestedSprint: a.suggestedSprint,
      nextStep: a.nextStep,
    };
  });
  const res = await jsonCompletion<{ plan: unknown }>({
    model,
    system: PLAN_SYSTEM,
    user: JSON.stringify(payload, null, 2),
    systemCacheable: true,
    maxTokens: 4000,
  });
  return asMarkdown(res.plan);
}

export async function runAnalysis(
  issues: JiraIssue[],
  p0Customers: P0Customer[],
  config: AppConfig,
  onProgress?: (event: { phase: string; done: number; total: number }) => void,
  /** Map of issue key -> authoritative P0 customer name (from JQL fragment match). */
  p0TicketMap: Map<string, string> = new Map(),
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
      const res = await analyzeBatch(batches[idx], model, p0NameSet);
      ticketAnalyses.push(...res);
      finished++;
      onProgress?.({ phase: "tickets", done: finished, total: batches.length });
    }
  }
  for (let i = 0; i < Math.min(PARALLEL, batches.length); i++) inFlight.push(worker());
  await Promise.all(inFlight);

  // Override Claude's customer inference with the authoritative JQL-fragment match.
  for (const a of ticketAnalyses) {
    const authoritative = p0TicketMap.get(a.issueKey);
    if (authoritative) {
      a.customer = authoritative;
      a.isP0Customer = true;
    }
  }

  ticketAnalyses.sort((a, b) => a.issueKey.localeCompare(b.issueKey));

  // Phase 2: P0 customer summaries
  const issuesByKey = new Map(issues.map((i) => [i.key, i]));
  const p0Summaries: P0Summary[] = [];
  onProgress?.({ phase: "p0", done: 0, total: p0Customers.length });
  for (let i = 0; i < p0Customers.length; i++) {
    const customer = p0Customers[i];
    const matchedKeys = new Set<string>();
    for (const [issueKey, name] of p0TicketMap) {
      if (name === customer.name) matchedKeys.add(issueKey);
    }
    const matched = ticketAnalyses
      .filter((a) => matchedKeys.has(a.issueKey) && a.status !== "resolved")
      .map((a) => issuesByKey.get(a.issueKey))
      .filter((x): x is JiraIssue => Boolean(x));
    const summary = await summarizeP0(customer, matched, model);
    p0Summaries.push(summary);
    onProgress?.({ phase: "p0", done: i + 1, total: p0Customers.length });
  }

  // Phase 3: two-sprint plan
  onProgress?.({ phase: "plan", done: 0, total: 1 });
  const twoSprintPlan = await generateTwoSprintPlan(ticketAnalyses, issuesByKey, model);
  onProgress?.({ phase: "plan", done: 1, total: 1 });

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
    twoSprintPlan,
    closeCandidates,
    pingCandidates,
  };
}

export { TEMP_BANDS };
