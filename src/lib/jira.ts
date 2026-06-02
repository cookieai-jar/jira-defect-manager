import type { JiraIssue, JiraComment, ResolvedTicketRef } from "@/types/triage";

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

interface RawJiraIssue {
  key: string;
  fields: {
    summary: string;
    status: { name: string; statusCategory: { key: string } };
    priority?: { name: string } | null;
    issuetype: { name: string };
    reporter?: { displayName: string } | null;
    assignee?: { displayName: string } | null;
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
  };
}

const FIELDS = [
  "summary",
  "status",
  "priority",
  "issuetype",
  "reporter",
  "assignee",
  "created",
  "updated",
  "resolutiondate",
  "labels",
  "components",
  "description",
  "comment",
].join(",");

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
