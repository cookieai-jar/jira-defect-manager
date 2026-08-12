/**
 * Shared primitives for building Confluence-pasteable HTML documents. Used by
 * the Strategic Integrations and Product Defect Analysis exports so the two
 * documents read identically: same markdown handling, same JIRA linkification,
 * same visual shell.
 *
 * The workflow both exports share: download the file, open it in a browser,
 * Select-All → Copy, paste into the Confluence editor. Confluence preserves
 * headings, tables, lists and every hyperlink.
 */

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** JQL search URL opening all the given tickets at once (mirrors JiraQueryLink). */
export function jqlSearchUrl(keys: string[], jiraBaseUrl: string): string | null {
  if (!jiraBaseUrl || keys.length === 0) return null;
  const jql = `key in (${keys.join(",")}) ORDER BY created DESC`;
  return `${jiraBaseUrl}/issues/?jql=${encodeURIComponent(jql)}`;
}

/** A link that opens N tickets in JIRA, or plain text when no base URL. */
export function jiraQueryLink(keys: string[], jiraBaseUrl: string, label?: string): string {
  const count = keys.length;
  if (count === 0) return "";
  const text = label ?? `View ${count} ticket${count === 1 ? "" : "s"} in JIRA`;
  const href = jqlSearchUrl(keys, jiraBaseUrl);
  if (!href) return `<span style="color:#6b778c">${count} ticket${count === 1 ? "" : "s"}</span>`;
  return `<a href="${escapeHtml(href)}">${escapeHtml(text)}</a>`;
}

/**
 * Minimal Markdown → HTML for the model-authored narrative fields. Handles the
 * subset the analysis produces: bold, italic, inline code, links, fenced code,
 * unordered/ordered lists, and paragraphs. Bare JIRA keys are linkified.
 */
export function mdToHtml(input: unknown, jiraBaseUrl: string): string {
  let text = typeof input === "string" ? input : input == null ? "" : String(input);
  if (!text.trim()) return "";

  // Protect fenced code blocks first.
  const codeBlocks: string[] = [];
  text = text.replace(/```[\s\S]*?```/g, (m) => {
    const body = m.replace(/^```[^\n]*\n?/, "").replace(/```$/, "");
    codeBlocks.push(`<pre><code>${escapeHtml(body)}</code></pre>`);
    return ` §CODE${codeBlocks.length - 1}§ `;
  });

  // Stash inline fragments behind a § sentinel so the bold/italic matchers
  // never touch them and the markers never collide with real digits.
  const inline = (raw: string): string => {
    const slots: string[] = [];
    const stash = (html: string): string => {
      slots.push(html);
      return `§${slots.length - 1}§`;
    };

    // Protect inline code and markdown links before escaping/linkifying.
    let s = raw.replace(/`([^`\n]+)`/g, (_m, c) => stash(`<code>${escapeHtml(c)}</code>`));
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label, url) =>
      stash(`<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`),
    );
    s = escapeHtml(s);

    // Linkify bare JIRA keys (e.g. EAC-61004) → /browse/<key>.
    if (jiraBaseUrl) {
      const KEY = /(?<![\w[(\-/])([A-Z][A-Z0-9]+-\d+)(?![\w\])-])/g;
      s = s.replace(KEY, (_m, key) => stash(`<a href="${jiraBaseUrl}/browse/${key}">${key}</a>`));
    }

    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/(?<!\*)\*(?!\*)([^*\n]+)\*(?!\*)/g, "<em>$1</em>");

    s = s.replace(/§(\d+)§/g, (_m, i) => slots[Number(i)]);
    return s;
  };

  const lines = text.split("\n");
  const out: string[] = [];
  let listType: "ul" | "ol" | null = null;
  let para: string[] = [];

  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${inline(para.join(" "))}</p>`);
      para = [];
    }
  };
  const closeList = () => {
    if (listType) {
      out.push(`</${listType}>`);
      listType = null;
    }
  };

  for (const line of lines) {
    const codePlaceholder = line.match(/^ §CODE(\d+)§ $/);
    if (codePlaceholder) {
      flushPara();
      closeList();
      out.push(codeBlocks[Number(codePlaceholder[1])]);
      continue;
    }
    if (!line.trim()) {
      flushPara();
      closeList();
      continue;
    }
    const ulMatch = line.match(/^\s*[-*+]\s+(.*)$/);
    const olMatch = line.match(/^\s*\d+\.\s+(.*)$/);
    if (ulMatch) {
      flushPara();
      if (listType !== "ul") {
        closeList();
        out.push("<ul>");
        listType = "ul";
      }
      out.push(`<li>${inline(ulMatch[1])}</li>`);
      continue;
    }
    if (olMatch) {
      flushPara();
      if (listType !== "ol") {
        closeList();
        out.push("<ol>");
        listType = "ol";
      }
      out.push(`<li>${inline(olMatch[1])}</li>`);
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushPara();
      closeList();
      const level = Math.min(6, heading[1].length + 2); // keep doc headings dominant
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }
    closeList();
    para.push(line.trim());
  }
  flushPara();
  closeList();

  let html = out.join("\n");
  html = html.replace(/ §CODE(\d+)§ /g, (_m, i) => codeBlocks[Number(i)]);
  return html;
}

export function badge(text: string): string {
  return `<span style="display:inline-block;border:1px solid #c1c7d0;border-radius:3px;padding:0 6px;font-size:12px;color:#42526e;background:#f4f5f7;margin-right:4px">${escapeHtml(text)}</span>`;
}

/** The self-contained document wrapper both exports share. */
export function confluenceDocShell(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #172b4d; line-height: 1.5; max-width: 980px; margin: 24px auto; padding: 0 24px; }
  h1 { font-size: 28px; border-bottom: 2px solid #dfe1e6; padding-bottom: 8px; }
  h2 { font-size: 22px; margin-top: 32px; border-bottom: 1px solid #dfe1e6; padding-bottom: 6px; }
  h3 { font-size: 18px; margin-top: 24px; }
  h4 { font-size: 15px; margin-top: 18px; }
  table { border-collapse: collapse; width: 100%; margin: 12px 0; }
  th, td { border: 1px solid #dfe1e6; padding: 8px 10px; text-align: left; vertical-align: top; }
  th { background: #f4f5f7; }
  blockquote { border-left: 3px solid #dfe1e6; margin: 8px 0; padding-left: 12px; color: #42526e; }
  code { background: #f4f5f7; padding: 1px 4px; border-radius: 3px; font-size: 90%; }
  pre { background: #f4f5f7; padding: 12px; border-radius: 4px; overflow-x: auto; }
  a { color: #0052cc; }
</style>
</head>
<body>
${body}
</body>
</html>`;
}
