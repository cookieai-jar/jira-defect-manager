/**
 * Take a user's master JQL and strip the clauses that would skew secondary
 * queries built on top of it:
 *
 *   - status / statusCategory / resolution — these hide closed tickets from
 *     queries that need to count or list them.
 *   - ORDER BY — irrelevant for filtering.
 *   - created / updated / resolutiondate — callers apply their own date
 *     window.
 *
 * Regex stripping is fragile in the general case but is good enough for the
 * shapes humans typically write.
 */
export function stripDynamicClauses(jql: string): string {
  let s = jql;
  s = s.replace(/\s+ORDER\s+BY\s+.*$/i, "");
  // Parenthesized compound clauses that contain a date field.
  s = s.replace(
    /\s+AND\s+\(\s*[^()]*\b(?:created|updated|resolutiondate)\b[^()]*\)/gi,
    "",
  );
  // Top-level status / statusCategory / resolution filters.
  s = s.replace(
    /\s+AND\s+status\s*(?:!=|=|not\s+in|in)\s*(?:"[^"]*"|\([^)]*\)|[^\s)]+)/gi,
    "",
  );
  s = s.replace(
    /\s+AND\s+statusCategory\s*(?:!=|=|not\s+in|in)\s*(?:"[^"]*"|\([^)]*\)|[^\s)]+)/gi,
    "",
  );
  s = s.replace(
    /\s+AND\s+resolution\s*(?:!=|=|is\s+not|is|in|not\s+in)\s*(?:"[^"]*"|\([^)]*\)|[^\s)]+)/gi,
    "",
  );
  // Top-level date filters.
  s = s.replace(
    /\s+AND\s+\b(?:created|updated|resolutiondate)\b\s*(?:>=|<=|>|<|=)\s*[^\s)]+/gi,
    "",
  );
  s = s.replace(/^\s*(?:AND|OR)\s+/i, "");
  return s.trim();
}

/**
 * Best-effort extraction of literal values from a JQL fragment so we can
 * locally match tickets without re-running the JQL against JIRA. Pulls:
 *
 *   - values inside `... in (X, Y, "Z")`
 *   - right-hand side of `... = "X"` / `... = X`
 *   - right-hand side of `... ~ "X"`  (text contains)
 *
 * Quotes are stripped. Returns deduplicated, non-empty tokens.
 */
export function extractMatchTokens(jqlFragment: string): string[] {
  const tokens = new Set<string>();
  for (const m of jqlFragment.matchAll(/\bin\s*\(([^)]+)\)/gi)) {
    for (const part of m[1].split(",")) {
      const v = part.trim().replace(/^"|"$/g, "").trim();
      if (v) tokens.add(v);
    }
  }
  for (const m of jqlFragment.matchAll(/(?:=|~)\s*("[^"]+"|'[^']+'|[A-Za-z][\w-]+)/g)) {
    const v = m[1].replace(/^["']|["']$/g, "").trim();
    if (v) tokens.add(v);
  }
  return Array.from(tokens).filter((t) => t.length > 1);
}
