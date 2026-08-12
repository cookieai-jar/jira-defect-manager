"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import {
  LayoutDashboard,
  Settings,
  Activity,
  ChevronDown,
  ClipboardList,
  ShieldAlert,
  Siren,
  Flame,
  Bug,
  Wrench,
  Gauge,
  BookOpen,
  HeartPulse,
  Bot,
  Microscope,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { AppConfig, Scope } from "@/types/triage";

interface NavItem {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
  /** If set, the item is shown only when config.dashboards[scope] is true. */
  scope?: Scope;
  /**
   * If set, the item is shown only when config[<flag>] is not false.
   * `siDashboard` stays in the union because the flag still gates the
   * /integrations route itself — that dashboard is simply no longer reachable
   * from the sidebar, having been superseded by the Integrations component page
   * under Product Defect Analysis.
   */
  flag?: "siDashboard" | "tenantDashboard" | "pdaDashboard";
}

interface NavGroup {
  /** Stable key for the disclosure's storage entry and its aria-controls id. */
  key: string;
  label: string;
  icon: typeof LayoutDashboard;
  /**
   * When set, the header is a link as well as a disclosure — the group itself is
   * a page. Overview has no such page (its summary is a child), so its header
   * only toggles.
   */
  href?: string;
  /** Static children, gated by the same scope/flag rules as top-level items. */
  children?: NavItem[];
  /** Children discovered at runtime from the stored report, one per component. */
  dynamic?: boolean;
  flag?: NavItem["flag"];
  /** Expanded when the reader has expressed no preference yet. */
  defaultOpen?: boolean;
}

type NavEntry = NavItem | NavGroup;

function isGroup(entry: NavEntry): entry is NavGroup {
  return "key" in entry;
}

const PDA_HREF = "/product-defects";

/** Shape of `GET /api/product-defects/components`, kept deliberately tiny. */
interface ComponentNavEntry {
  component: string;
  slug: string;
  defectCount: number;
}

/**
 * Disclosure state outlives a full page load, not just soft navigation — a
 * reader who collapsed a long list should not have to re-collapse it after
 * every reload.
 */
const openKey = (group: string) => `nav.${group}.expanded`;

const NAV: NavEntry[] = [
  {
    key: "overview",
    label: "Overview",
    icon: Gauge,
    // Open by default: these are the day-to-day dashboards, and a collapsed
    // group would hide almost the whole app behind one click.
    defaultOpen: true,
    children: [
      { href: "/overview", label: "Summary", icon: Gauge },
      { href: "/all-defects", label: "All Defects", icon: Bug, scope: "alldefects" },
      { href: "/ops", label: "OPS", icon: Wrench, scope: "ops" },
      { href: "/", label: "Customer Defects", icon: LayoutDashboard, scope: "eac" },
      { href: "/automation", label: "Automation Defects", icon: Bot, scope: "automation" },
      { href: "/fr/poc", label: "Feature Requests", icon: ClipboardList, scope: "fr" },
      { href: "/security", label: "Vulnerabilities", icon: ShieldAlert, scope: "sec" },
      { href: "/alerts", label: "Alerts", icon: Siren, scope: "alerts" },
      { href: "/incidents", label: "Incidents", icon: Flame, scope: "incidents" },
      { href: "/tenants", label: "Tenant Health", icon: HeartPulse, flag: "tenantDashboard" },
    ],
  },
  {
    key: "product-defects",
    label: "Product Defect Analysis",
    icon: Microscope,
    href: PDA_HREF,
    dynamic: true,
    flag: "pdaDashboard",
    defaultOpen: true,
  },
  { href: "/definitions", label: "Priority Definitions/SLAs", icon: BookOpen },
  { href: "/settings", label: "Settings", icon: Settings },
];

export function Nav() {
  const pathname = usePathname();
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [components, setComponents] = useState<ComponentNavEntry[]>([]);
  /**
   * group key -> expanded. Seeded from the declared defaults rather than from
   * localStorage so the server render and the first client render agree; the
   * stored preference is applied in an effect straight after. Seeding empty
   * instead would paint every group collapsed and then snap open on hydration.
   */
  const [open, setOpen] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(
      NAV.filter(isGroup).map((g) => [g.key, !!g.defaultOpen]),
    ),
  );

  const inPda = pathname === PDA_HREF || pathname.startsWith(`${PDA_HREF}/`);

  useEffect(() => {
    let cancelled = false;
    function refetch() {
      fetch("/api/config")
        .then((r) => r.json())
        .then((c: AppConfig) => {
          if (!cancelled) setConfig(c);
        })
        .catch(() => {});
    }
    refetch();
    window.addEventListener("app-config-changed", refetch);
    return () => {
      cancelled = true;
      window.removeEventListener("app-config-changed", refetch);
    };
  }, [pathname]);

  // Apply the reader's stored preference over the defaults. Only groups with a
  // recorded choice are overridden, so adding a new default-open group later
  // doesn't get suppressed by an unrelated older entry.
  useEffect(() => {
    setOpen((prev) => {
      const next = { ...prev };
      for (const entry of NAV) {
        if (!isGroup(entry)) continue;
        const stored = window.localStorage.getItem(openKey(entry.key));
        if (stored !== null) next[entry.key] = stored === "1";
      }
      return next;
    });
  }, []);

  /**
   * Fetched on mount and again when the reader crosses into or out of the
   * section. The endpoint parses the stored report, so re-fetching on every
   * navigation would be wasteful — and the component list only changes when
   * Sync & Analyze runs, which happens from inside this section.
   */
  useEffect(() => {
    let cancelled = false;
    fetch("/api/product-defects/components")
      .then((r) => (r.ok ? r.json() : []))
      .then((list: unknown) => {
        if (!cancelled && Array.isArray(list)) setComponents(list as ComponentNavEntry[]);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [inPda]);

  const toggle = useCallback((key: string) => {
    setOpen((prev) => {
      const next = !prev[key];
      window.localStorage.setItem(openKey(key), next ? "1" : "0");
      return { ...prev, [key]: next };
    });
  }, []);

  const visible = (item: NavItem) => {
    if (!config) return true; // before config loads, show everything
    if (item.scope) return config.dashboards?.[item.scope] !== false;
    if (item.flag) return config[item.flag] !== false;
    return true;
  };

  return (
    <aside className="hidden md:flex flex-col w-72 shrink-0 border-r border-border bg-bg-muted">
      <div className="flex items-center gap-2 px-4 h-14 border-b border-border">
        <div className="h-7 w-7 rounded bg-accent/20 border border-accent/40 flex items-center justify-center">
          <Activity className="h-4 w-4 text-accent" />
        </div>
        <div className="text-sm font-semibold">JIRA Manager</div>
      </div>
      <nav className="flex-1 px-2 py-3 space-y-1 overflow-y-auto scroll-thin">
        {NAV.map((entry) => {
          if (!isGroup(entry)) {
            return visible(entry) ? (
              <NavLink key={entry.href} item={entry} active={pathname === entry.href} />
            ) : null;
          }
          if (entry.flag && config && config[entry.flag] === false) return null;

          const staticChildren = (entry.children ?? []).filter(visible);
          const expanded = !!open[entry.key];
          const listId = `nav-${entry.key}-children`;
          // A disclosure that opens onto nothing is worse than no disclosure, so
          // a dynamic group with no components yet renders as a plain link.
          const hasChildren = entry.dynamic ? components.length > 0 : staticChildren.length > 0;

          if (!hasChildren) {
            return entry.href ? (
              <NavLink
                key={entry.key}
                item={{ href: entry.href, label: entry.label, icon: entry.icon }}
                active={pathname === entry.href}
              />
            ) : null;
          }

          return (
            <div key={entry.key}>
              <div className="flex items-center gap-0.5">
                {entry.href ? (
                  <NavLink
                    item={{ href: entry.href, label: entry.label, icon: entry.icon }}
                    active={pathname === entry.href}
                    className="flex-1 min-w-0"
                  />
                ) : (
                  // No page of its own: the whole row toggles, so the click
                  // target matches what actually happens.
                  <button
                    type="button"
                    onClick={() => toggle(entry.key)}
                    aria-expanded={expanded}
                    aria-controls={expanded ? listId : undefined}
                    className="flex-1 min-w-0 flex items-center gap-2 px-3 py-2 rounded text-sm text-fg-muted hover:text-fg hover:bg-bg-card/50 transition-colors"
                  >
                    <entry.icon className="h-4 w-4 shrink-0" />
                    <span className="truncate">{entry.label}</span>
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => toggle(entry.key)}
                  aria-expanded={expanded}
                  aria-controls={expanded ? listId : undefined}
                  aria-label={`${expanded ? "Collapse" : "Expand"} ${entry.label}`}
                  className="shrink-0 rounded p-1.5 text-fg-subtle hover:text-fg hover:bg-bg-card/50 transition-colors"
                >
                  <ChevronDown
                    className={cn(
                      "h-3.5 w-3.5 transition-transform",
                      expanded ? "rotate-0" : "-rotate-90",
                    )}
                  />
                </button>
              </div>
              {expanded && (
                <ul
                  id={listId}
                  className="mt-0.5 ml-4 pl-2 border-l border-border space-y-0.5"
                >
                  {entry.dynamic
                    ? components.map((c) => (
                        <ChildLink
                          key={c.slug}
                          href={`${PDA_HREF}/${c.slug}`}
                          label={c.component}
                          count={c.defectCount}
                          active={pathname === `${PDA_HREF}/${c.slug}`}
                          title={`${c.component} · ${c.defectCount} defects`}
                        />
                      ))
                    : staticChildren.map((child) => (
                        <ChildLink
                          key={child.href}
                          href={child.href}
                          label={child.label}
                          icon={child.icon}
                          active={pathname === child.href}
                        />
                      ))}
                </ul>
              )}
            </div>
          );
        })}
      </nav>
      <div className="px-4 py-3 border-t border-border text-[11px] text-fg-subtle">
        v0.1.0 · {new Date().toISOString().slice(0, 10)}
      </div>
    </aside>
  );
}

/**
 * A top-level nav entry. Split out so a parent row can put the link and its
 * disclosure toggle side by side: clicking the label must still navigate to the
 * page, never merely toggle.
 */
function NavLink({
  item,
  active,
  className,
}: {
  item: NavItem;
  active: boolean;
  className?: string;
}) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex items-center gap-2 px-3 py-2 rounded text-sm transition-colors",
        active
          ? "bg-bg-card text-fg border border-border-strong"
          : "text-fg-muted hover:text-fg hover:bg-bg-card/50",
        className,
      )}
    >
      <Icon className="h-4 w-4 shrink-0" />
      <span className="truncate">{item.label}</span>
    </Link>
  );
}

/** A nested entry. Carries an icon (a real dashboard) or a count (a component). */
function ChildLink({
  href,
  label,
  active,
  icon: Icon,
  count,
  title,
}: {
  href: string;
  label: string;
  active: boolean;
  icon?: typeof LayoutDashboard;
  count?: number;
  title?: string;
}) {
  return (
    <li>
      <Link
        href={href}
        aria-current={active ? "page" : undefined}
        title={title}
        className={cn(
          "flex items-center gap-2 pl-2 pr-2 py-1 rounded text-[13px] transition-colors",
          active
            ? "bg-bg-card text-fg border border-border-strong"
            : "text-fg-muted hover:text-fg hover:bg-bg-card/50",
        )}
      >
        {Icon && <Icon className="h-3.5 w-3.5 shrink-0" />}
        <span className="truncate">{label}</span>
        {count !== undefined && (
          <span className="ml-auto shrink-0 font-mono text-[10px] text-fg-subtle">{count}</span>
        )}
      </Link>
    </li>
  );
}
