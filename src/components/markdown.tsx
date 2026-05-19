"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

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

export function Markdown({ children }: { children: unknown }) {
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
            <a {...props} href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          ),
        }}
      >
        {toMarkdownString(children)}
      </ReactMarkdown>
    </div>
  );
}
