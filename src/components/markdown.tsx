"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { transformChildrenWithChips } from "@/components/jira-chips";

function toMarkdownString(input: unknown): string {
  if (typeof input === "string") return input;
  if (Array.isArray(input)) {
    return input
      .map((x) => (typeof x === "string" ? x : JSON.stringify(x)))
      .filter(Boolean)
      .join("\n");
  }
  if (input == null) return "";
  return String(input);
}

/**
 * Wrap bare JIRA keys (e.g. EAC-61004) in markdown links to /browse/<key>.
 * Skips text inside fenced code blocks and inline code, and avoids re-wrapping
 * keys already inside markdown link brackets `[...](...)`.
 */
function linkifyJira(text: string, baseUrl: string): string {
  if (!baseUrl) return text;
  // Split out fenced code blocks and inline code so we don't touch them.
  const parts = text.split(/(```[\s\S]*?```|`[^`\n]*`)/g);
  const KEY = /(?<![\w[(\-/])([A-Z][A-Z0-9]+-\d+)(?![\w\])-])/g;
  return parts
    .map((part, idx) => {
      if (idx % 2 === 1) return part;
      return part.replace(KEY, (_m, key) => `[${key}](${baseUrl}/browse/${key})`);
    })
    .join("");
}

export function Markdown({
  children,
  jiraBaseUrl,
}: {
  children: unknown;
  jiraBaseUrl?: string;
}) {
  const raw = toMarkdownString(children);
  const text = jiraBaseUrl ? linkifyJira(raw, jiraBaseUrl) : raw;
  return (
    <div className="prose-tight text-sm text-fg">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          input: ({ ...props }) => (
            <input
              {...props}
              className="mr-1.5 h-3 w-3 accent-accent translate-y-[1px]"
              readOnly
            />
          ),
          a: ({ href, children, ...props }) => (
            <a
              {...props}
              href={href}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-accent hover:text-accent-hover underline decoration-accent/40 hover:decoration-accent"
            >
              {children}
            </a>
          ),
          // Wrap [Pn] and [status] tokens in colored chips wherever they
          // appear inline. We override the elements most likely to host
          // such tokens; nested inline tags (strong, em) keep their structure
          // but their text-node siblings get the chip treatment too.
          li: ({ children, ...props }) => (
            <li {...props}>{transformChildrenWithChips(children, "li-")}</li>
          ),
          p: ({ children, ...props }) => (
            <p {...props}>{transformChildrenWithChips(children, "p-")}</p>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
