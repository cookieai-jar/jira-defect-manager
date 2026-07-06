import type { JiraIssue, JiraComment, ResolvedTicketRef, RoadmapDependency } from "@/types/triage";
import { classifyDependency, missingEacFields, pingStatsFromComments, type RoadmapIssueInput } from "@/lib/fr-roadmap";

/** JIRA field ids for the EAC planning fields the roadmap flags when unset. */
const DUE_DATE_FIELD = "duedate";
const ORIGINAL_ESTIMATE_FIELD = "timeoriginalestimate";
const SPRINT_FIELD = "customfield_10020";

interface JiraEnv {
  baseUrl: string;
  email: string;
  token: string;
}

function env(): JiraEnv {
  const baseUrl = process.env.JIRA_BASE_URL?.replace(/\/$/, "");
  const email = process.env.JIRA_EMAIL;
  const token = process.env.JIRA_API_TOKEN;
  if (!baseUrl || !email || !token) {
    throw new Error(
      "Missing JIRA credentials. Set JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN in .env.local",
    );
  }
  return { baseUrl, email, token };
}

function authHeader({ email, token }: JiraEnv): string {
  const b64 = Buffer.from(`${email}:${token}`).toString("base64");
  return `Basic ${b64}`;
}

async function jiraFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const e = env();
  const res = await fetch(`${e.baseUrl}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: authHeader(e),
      ...(init.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`JIRA ${res.status} on ${path}: ${text.slice(0, 500)}`);
  }
  return (await res.json()) as T;
}

/** JIRA custom field id for the "Customer" multi-select (verified via spike). */
export const CUSTOMER_FIELD = "customfield_10044";
/** "Targeted Month" single-select (e.g. "Jul '26") — an FR's committed month. */
export const TARGETED_MONTH_FIELD = "customfield_11123";

/** A multi-select option as JIRA serializes it: { self, value, id }. */
interface JiraOption {
  value?: string;
  name?: string;
}

interface RawJiraIssue {
  key: string;
  fields: {
    [CUSTOMER_FIELD]?: JiraOption[] | null;
    [TARGETED_MONTH_FIELD]?: JiraOption | null;
    summary: string;
    status: { name: string; statusCategory: { key: string } };
    priority?: { name: string } | null;
    issuetype: { name: string };
    reporter?: { displayName: string } | null;
    assignee?: { displayName: string } | null;
    parent?: {
      key: string;
      fields?: { summary?: string; issuetype?: { name?: string } };
    } | null;
    created: string;
    updated: string;
    resolutiondate: string | null;
    labels: string[];
    components: { name: string }[];
    description: unknown;
    comment?: {
      comments: Array<{
        id: string;
        author: { displayName: string };
        body: unknown;
        created: string;
        updated: string;
      }>;
    };
  };
}

function adfToPlainText(node: unknown): string {
  if (!node) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(adfToPlainText).join("");
  if (typeof node === "object") {
    const n = node as { type?: string; text?: string; content?: unknown };
    if (n.text) return n.text;
    if (n.content) {
      const inner = adfToPlainText(n.content);
      if (n.type === "paragraph" || n.type === "heading") return inner + "\n";
      if (n.type === "listItem") return "- " + inner + "\n";
      return inner;
    }
  }
  return "";
}

function normalizeIssue(raw: RawJiraIssue, baseUrl: string): JiraIssue {
  const comments: JiraComment[] = (raw.fields.comment?.comments ?? []).map((c) => ({
    id: c.id,
    author: c.author?.displayName ?? "unknown",
    body: adfToPlainText(c.body).trim(),
    created: c.created,
    updated: c.updated,
  }));
  const statusCategoryKey = raw.fields.status.statusCategory.key;
  const statusCategory: JiraIssue["statusCategory"] =
    statusCategoryKey === "new" || statusCategoryKey === "indeterminate" || statusCategoryKey === "done"
      ? statusCategoryKey
      : "undefined";
  return {
    key: raw.key,
    summary: raw.fields.summary,
    status: raw.fields.status.name,
    statusCategory,
    priority: raw.fields.priority?.name ?? null,
    issueType: raw.fields.issuetype.name,
    reporter: raw.fields.reporter?.displayName ?? null,
    assignee: raw.fields.assignee?.displayName ?? null,
    created: raw.fields.created,
    updated: raw.fields.updated,
    resolved: raw.fields.resolutiondate,
    labels: raw.fields.labels ?? [],
    components: (raw.fields.components ?? []).map((c) => c.name),
    description: adfToPlainText(raw.fields.description).trim() || null,
    url: `${baseUrl}/browse/${raw.key}`,
    comments,
    parent: raw.fields.parent
      ? {
          key: raw.fields.parent.key,
          summary: raw.fields.parent.fields?.summary ?? "",
          type: raw.fields.parent.fields?.issuetype?.name ?? "",
        }
      : null,
    customers: extractCustomers(raw.fields[CUSTOMER_FIELD]),
    targetedMonth: raw.fields[TARGETED_MONTH_FIELD]?.value?.trim() || null,
  };
}

/**
 * Pull the display values out of the "Customer" multi-select field. Each option
 * serializes as { value, id }; we keep `value` (the tenant name). Tolerates
 * null/undefined/empty and options that use `name` instead of `value`.
 */
export function extractCustomers(raw: JiraOption[] | null | undefined): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((o) => (o?.value ?? o?.name ?? "").trim())
    .filter((s) => s.length > 0);
}

const FIELDS = [
  "summary",
  "status",
  "priority",
  "issuetype",
  "reporter",
  "assignee",
  "parent",
  "created",
  "updated",
  "resolutiondate",
  "labels",
  "components",
  "description",
  "comment",
  CUSTOMER_FIELD,
  TARGETED_MONTH_FIELD,
].join(",");

/**
 * Fetch the allowed-value option list for the Customer field (customfield_10044)
 * — the authoritative set of customer display names. Reads the field's first
 * context, then pages its options.
 */
export async function fetchCustomerFieldOptions(): Promise<string[]> {
  const contexts = await jiraFetch<{ values?: Array<{ id: string }> }>(
    `/rest/api/3/field/${CUSTOMER_FIELD}/context?maxResults=50`,
  );
  const ctxId = contexts.values?.[0]?.id;
  if (!ctxId) return [];
  const names: string[] = [];
  let startAt = 0;
  for (;;) {
    const page = await jiraFetch<{ values?: Array<{ value?: string }>; isLast?: boolean }>(
      `/rest/api/3/field/${CUSTOMER_FIELD}/context/${ctxId}/option?maxResults=100&startAt=${startAt}`,
    );
    const vals = page.values ?? [];
    for (const o of vals) if (o.value) names.push(o.value);
    if (page.isLast || vals.length === 0) break;
    startAt += vals.length;
    if (startAt > 10000) break; // safety bound
  }
  return names;
}

export async function searchIssues(jql: string, maxResults = 200): Promise<JiraIssue[]> {
  const e = env();
  const out: JiraIssue[] = [];
  let nextPageToken: string | undefined;
  const pageSize = Math.min(100, maxResults);
  while (out.length < maxResults) {
    const body: Record<string, unknown> = {
      jql,
      fields: FIELDS.split(","),
      maxResults: Math.min(pageSize, maxResults - out.length),
    };
    if (nextPageToken) body.nextPageToken = nextPageToken;
    const res = await jiraFetch<{
      issues: RawJiraIssue[];
      nextPageToken?: string;
      isLast?: boolean;
    }>("/rest/api/3/search/jql", {
      method: "POST",
      body: JSON.stringify(body),
    });
    out.push(...res.issues.map((raw) => normalizeIssue(raw, e.baseUrl)));
    if (res.isLast || !res.nextPageToken || res.issues.length === 0) break;
    nextPageToken = res.nextPageToken;
  }
  return out;
}

/**
 * Page through ALL issues matching the JQL, batching 100 at a time until JIRA
 * reports the last page. `hardCap` is a safety bound to avoid an unbounded
 * fetch (and logs when hit). Use when the full population is needed rather than
 * a capped sample.
 */
export async function searchAllIssues(jql: string, hardCap = 20000): Promise<JiraIssue[]> {
  const e = env();
  const out: JiraIssue[] = [];
  let nextPageToken: string | undefined;
  while (out.length < hardCap) {
    const body: Record<string, unknown> = {
      jql,
      fields: FIELDS.split(","),
      maxResults: 100,
    };
    if (nextPageToken) body.nextPageToken = nextPageToken;
    const res = await jiraFetch<{
      issues: RawJiraIssue[];
      nextPageToken?: string;
      isLast?: boolean;
    }>("/rest/api/3/search/jql", {
      method: "POST",
      body: JSON.stringify(body),
    });
    out.push(...res.issues.map((raw) => normalizeIssue(raw, e.baseUrl)));
    if (res.isLast || !res.nextPageToken || res.issues.length === 0) break;
    nextPageToken = res.nextPageToken;
  }
  if (out.length >= hardCap) {
    console.warn(`[searchAllIssues] hit hard cap of ${hardCap} issues; results truncated`);
  }
  return out;
}

// --- committed roadmap (FR target-month → child epics + dependency links) -----

function statusCat(key: string | undefined): JiraIssue["statusCategory"] {
  return key === "new" || key === "indeterminate" || key === "done" ? key : "undefined";
}

export interface RawLinkedIssue {
  key: string;
  fields?: { summary?: string; status?: { name?: string; statusCategory?: { key?: string } } };
}
export interface RawIssueLink {
  type?: { name?: string; inward?: string; outward?: string };
  inwardIssue?: RawLinkedIssue;
  outwardIssue?: RawLinkedIssue;
}

/** PURE. Map JIRA issuelinks to RoadmapDependency[] (outward→type.outward, inward→type.inward). */
export function parseDependencies(links: RawIssueLink[] | undefined, baseUrl: string): RoadmapDependency[] {
  const out: RoadmapDependency[] = [];
  for (const l of links ?? []) {
    // outwardIssue uses the outward phrase ("blocks"); inwardIssue the inward ("is blocked by").
    const linked = l.outwardIssue ?? l.inwardIssue;
    if (!linked) continue;
    const phrase = l.outwardIssue ? l.type?.outward ?? "" : l.type?.inward ?? "";
    const cat = statusCat(linked.fields?.status?.statusCategory?.key);
    const { direction, isBlocker } = classifyDependency(phrase, cat === "done");
    out.push({
      key: linked.key,
      summary: linked.fields?.summary ?? "",
      status: linked.fields?.status?.name ?? "",
      statusCategory: cat,
      direction,
      url: `${baseUrl}/browse/${linked.key}`,
      isBlocker,
    });
  }
  return out;
}

interface RawRoadmapIssue {
  key: string;
  fields: {
    summary: string;
    status: { name: string; statusCategory: { key: string } };
    issuetype: { name: string };
    parent?: { key: string } | null;
    issuelinks?: RawIssueLink[];
    assignee?: { accountId?: string; displayName?: string } | null;
    comment?: { comments?: Array<{ created: string; body: unknown }> } | null;
    [TARGETED_MONTH_FIELD]?: JiraOption | null;
    [DUE_DATE_FIELD]?: string | null;
    [ORIGINAL_ESTIMATE_FIELD]?: number | null;
    [SPRINT_FIELD]?: unknown[] | null;
  };
}

const ROADMAP_FIELDS = [
  "summary",
  "status",
  "issuetype",
  "parent",
  "issuelinks",
  "assignee",
  "comment",
  TARGETED_MONTH_FIELD,
  DUE_DATE_FIELD,
  ORIGINAL_ESTIMATE_FIELD,
  SPRINT_FIELD,
];

/** PURE-ish. Map one raw roadmap issue to a RoadmapIssueInput. */
function toRoadmapInput(raw: RawRoadmapIssue, baseUrl: string): RoadmapIssueInput {
  const acc = raw.fields.assignee;
  const pings = pingStatsFromComments(
    (raw.fields.comment?.comments ?? []).map((c) => ({ createdAt: c.created, text: adfToPlainText(c.body) })),
  );
  return {
    key: raw.key,
    summary: raw.fields.summary,
    status: raw.fields.status.name,
    statusCategory: statusCat(raw.fields.status.statusCategory.key),
    issueType: raw.fields.issuetype.name,
    parentKey: raw.fields.parent?.key ?? null,
    targetedMonth: raw.fields[TARGETED_MONTH_FIELD]?.value?.trim() || null,
    dependencies: parseDependencies(raw.fields.issuelinks, baseUrl),
    missingFields: missingEacFields({
      dueDate: raw.fields[DUE_DATE_FIELD],
      originalEstimate: raw.fields[ORIGINAL_ESTIMATE_FIELD],
      sprint: raw.fields[SPRINT_FIELD],
    }),
    assignee: acc?.accountId ? { accountId: acc.accountId, displayName: acc.displayName ?? "assignee" } : null,
    pingCount: pings.count,
    lastPingedAt: pings.lastPingedAt,
  };
}

/**
 * Fetch lightweight roadmap records (status + parent + parsed dependency links +
 * targeted month) for the given JQL. Used to pull committed FRs + their child
 * epics in one pass. Paginates to `maxResults`.
 */
export async function searchRoadmapIssues(jql: string, maxResults = 1000): Promise<RoadmapIssueInput[]> {
  const e = env();
  const out: RoadmapIssueInput[] = [];
  let nextPageToken: string | undefined;
  while (out.length < maxResults) {
    const body: Record<string, unknown> = {
      jql,
      fields: ROADMAP_FIELDS,
      maxResults: Math.min(100, maxResults - out.length),
    };
    if (nextPageToken) body.nextPageToken = nextPageToken;
    const res = await jiraFetch<{ issues: RawRoadmapIssue[]; nextPageToken?: string; isLast?: boolean }>(
      "/rest/api/3/search/jql",
      { method: "POST", body: JSON.stringify(body) },
    );
    for (const raw of res.issues) out.push(toRoadmapInput(raw, e.baseUrl));
    if (res.isLast || !res.nextPageToken || res.issues.length === 0) break;
    nextPageToken = res.nextPageToken;
  }
  return out;
}

/** Fetch a single issue as a roadmap record (fresh assignee + missing-field state). */
export async function fetchRoadmapIssue(key: string): Promise<RoadmapIssueInput> {
  const e = env();
  const raw = await jiraFetch<RawRoadmapIssue>(
    `/rest/api/3/issue/${encodeURIComponent(key)}?fields=${ROADMAP_FIELDS.join(",")}`,
  );
  return toRoadmapInput(raw, e.baseUrl);
}

/** Post a comment (ADF body) to an issue. Outward-facing — notifies watchers/mentions. */
export async function addIssueComment(key: string, body: unknown): Promise<void> {
  await jiraFetch(`/rest/api/3/issue/${encodeURIComponent(key)}/comment`, {
    method: "POST",
    body: JSON.stringify({ body }),
  });
}

interface TrendIssue {
  key: string;
  created: string;
  resolved: string | null;
}

/**
 * Lightweight resolved-ticket fetch for white-glove customer tiles — pulls
 * summary, resolutiondate, and assignee so we can render a compact list.
 */
export async function searchResolvedRefs(
  jql: string,
  maxResults = 500,
): Promise<ResolvedTicketRef[]> {
  const e = env();
  const out: ResolvedTicketRef[] = [];
  let nextPageToken: string | undefined;
  const pageSize = Math.min(100, maxResults);
  while (out.length < maxResults) {
    const body: Record<string, unknown> = {
      jql,
      fields: ["summary", "resolutiondate", "assignee", "priority", "status"],
      maxResults: Math.min(pageSize, maxResults - out.length),
    };
    if (nextPageToken) body.nextPageToken = nextPageToken;
    const res = await jiraFetch<{
      issues: Array<{
        key: string;
        fields: {
          summary: string;
          resolutiondate: string | null;
          assignee?: { displayName: string } | null;
          priority?: { name: string } | null;
          status?: { name: string } | null;
        };
      }>;
      nextPageToken?: string;
      isLast?: boolean;
    }>("/rest/api/3/search/jql", {
      method: "POST",
      body: JSON.stringify(body),
    });
    out.push(
      ...res.issues.map((raw) => ({
        key: raw.key,
        summary: raw.fields.summary,
        resolved: raw.fields.resolutiondate,
        assignee: raw.fields.assignee?.displayName ?? null,
        url: `${e.baseUrl}/browse/${raw.key}`,
        priority: raw.fields.priority?.name ?? null,
        status: raw.fields.status?.name ?? null,
      })),
    );
    if (res.isLast || !res.nextPageToken || res.issues.length === 0) break;
    nextPageToken = res.nextPageToken;
  }
  return out;
}

/**
 * Lightweight search used for the trend chart — pulls only `created` and
 * `resolutiondate` for each issue so trend math doesn't drag full payloads.
 */
export async function searchTrendKeys(jql: string, maxResults = 1000): Promise<TrendIssue[]> {
  const e = env();
  const out: TrendIssue[] = [];
  let nextPageToken: string | undefined;
  const pageSize = Math.min(100, maxResults);
  while (out.length < maxResults) {
    const body: Record<string, unknown> = {
      jql,
      fields: ["created", "resolutiondate"],
      maxResults: Math.min(pageSize, maxResults - out.length),
    };
    if (nextPageToken) body.nextPageToken = nextPageToken;
    const res = await jiraFetch<{
      issues: Array<{ key: string; fields: { created: string; resolutiondate: string | null } }>;
      nextPageToken?: string;
      isLast?: boolean;
    }>("/rest/api/3/search/jql", {
      method: "POST",
      body: JSON.stringify(body),
    });
    out.push(
      ...res.issues.map((raw) => ({
        key: raw.key,
        created: raw.fields.created,
        resolved: raw.fields.resolutiondate,
      })),
    );
    if (res.isLast || !res.nextPageToken || res.issues.length === 0) break;
    nextPageToken = res.nextPageToken;
  }
  void e;
  return out;
}

export async function pingJira(): Promise<{ ok: true; user: string } | { ok: false; error: string }> {
  try {
    const me = await jiraFetch<{ displayName: string; emailAddress: string }>("/rest/api/3/myself");
    return { ok: true, user: me.displayName || me.emailAddress };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
