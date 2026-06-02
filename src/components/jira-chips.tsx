"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { priorityFromString } from "@/lib/priority";
import type { Priority } from "@/types/triage";

const PRIORITY_CLASSES: Record<Priority, string> = {
  P0: "border-danger/50 bg-danger/15 text-danger",
  P1: "border-warning/50 bg-warning/15 text-warning",
  P2: "border-accent/50 bg-accent/15 text-accent",
  P3: "border-success/50 bg-success/15 text-success",
};

/**
 * Pick a tailwind class set for an arbitrary JIRA status string by family:
 *
 *   - blocked / on hold              -> danger
 *   - in progress / investigation /
 *     review / design / development  -> accent
 *   - done / closed / resolved /
 *     fixed / shipped                -> success
 *   - backlog / open / to-do / new /
 *     selected                       -> neutral
 *   - won't do / abandoned           -> subtle
 *   - anything else                  -> neutral
 */
export function statusChipClass(status: string): string {
  const norm = status.toLowerCase().trim();
  if (/^(blocked|on\s*hold)$/.test(norm) || /blocked/.test(norm)) {
    return "border-danger/50 bg-danger/15 text-danger";
  }
  if (/(in.*progress|investigation|review|design|development|triage|analysis)/.test(norm)) {
    return "border-accent/50 bg-accent/15 text-accent";
  }
  if (/(done|closed|resolved|fixed|shipped|completed)/.test(norm)) {
    return "border-success/50 bg-success/15 text-success";
  }
  if (/(won.?t|abandon|cancel|dropped)/.test(norm)) {
    return "border-fg-subtle/40 bg-fg-subtle/10 text-fg-subtle";
  }
  if (/(backlog|to.?do|open|new|selected|ready)/.test(norm)) {
    return "border-warning/40 bg-warning/10 text-warning";
  }
  return "border-fg-subtle/40 bg-fg-subtle/10 text-fg-muted";
}

const CHIP_BASE =
  "inline-flex items-center align-baseline rounded border px-1.5 py-px mx-0.5 text-[10px] font-mono font-semibold leading-none";

export function PriorityChip({ priority, raw }: { priority: Priority; raw?: string }) {
  return (
    <span className={cn(CHIP_BASE, PRIORITY_CLASSES[priority])}>
      {raw ?? priority}
    </span>
  );
}

export function StatusChip({ status }: { status: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center align-baseline rounded border px-1.5 py-px mx-0.5 text-[10px] font-medium leading-none uppercase tracking-wide",
        statusChipClass(status),
      )}
    >
      {status}
    </span>
  );
}

/**
 * Walk a text string and replace `[P0]`/`[P1]`/`[P2]`/`[P3]` tokens — plus a
 * `[status]` token that immediately follows a priority token — with chip
 * components. Other bracketed text is left alone (to avoid eating markdown
 * link references).
 */
export function renderTextWithChips(text: string, keyPrefix = ""): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  const PAIR = /\[(P[0-3])\](\s*)\[([^\]\n]{1,80})\]/g;
  const LONE_PRIORITY = /\[(P[0-3])\]/g;
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  PAIR.lastIndex = 0;
  while ((m = PAIR.exec(text)) !== null) {
    if (m.index > lastIndex) {
      parts.push(
        ...renderLonePriority(text.slice(lastIndex, m.index), `${keyPrefix}t-${m.index}-`),
      );
    }
    parts.push(
      <PriorityChip
        key={`${keyPrefix}p-${m.index}`}
        priority={(priorityFromString(m[1]) ?? "P3") as Priority}
        raw={m[1]}
      />,
    );
    if (m[2]) parts.push(m[2]);
    parts.push(<StatusChip key={`${keyPrefix}s-${m.index}`} status={m[3].trim()} />);
    lastIndex = m.index + m[0].length;
  }
  if (lastIndex < text.length) {
    parts.push(...renderLonePriority(text.slice(lastIndex), `${keyPrefix}tail-`));
  }
  return parts;

  function renderLonePriority(s: string, kp: string): React.ReactNode[] {
    const out: React.ReactNode[] = [];
    let last = 0;
    let mm: RegExpExecArray | null;
    LONE_PRIORITY.lastIndex = 0;
    while ((mm = LONE_PRIORITY.exec(s)) !== null) {
      if (mm.index > last) out.push(s.slice(last, mm.index));
      out.push(
        <PriorityChip
          key={`${kp}lp-${mm.index}`}
          priority={(priorityFromString(mm[1]) ?? "P3") as Priority}
          raw={mm[1]}
        />,
      );
      last = mm.index + mm[0].length;
    }
    if (last < s.length) out.push(s.slice(last));
    return out;
  }
}

/**
 * Map ReactNode children (typically what react-markdown hands an inline-level
 * component override) — strings get split and chip-ified, other nodes pass
 * through.
 */
export function transformChildrenWithChips(
  children: React.ReactNode,
  keyPrefix = "",
): React.ReactNode {
  if (children == null) return children;
  if (typeof children === "string") return renderTextWithChips(children, keyPrefix);
  if (Array.isArray(children)) {
    const out: React.ReactNode[] = [];
    children.forEach((c, i) => {
      if (typeof c === "string") {
        out.push(...renderTextWithChips(c, `${keyPrefix}${i}-`));
      } else {
        out.push(c);
      }
    });
    return out;
  }
  return children;
}
