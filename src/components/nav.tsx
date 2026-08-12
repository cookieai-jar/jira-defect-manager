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

/** Parent whose children are discovered at runtime, one per JIRA component. */
const PDA_HREF = "/product-defects";

/** Shape of `GET /api/product-defects/components`, kept deliberately tiny. */
interface ComponentNavEntry {
  component: string;
  slug: string;
  defectCount: number;
}

/**
 * The disclosure state outlives a full page load, not just soft navigation —
 * a reader who opened the component list should not have to re-open it after
 * every reload.
 */
const PDA_OPEN_KEY = "nav.product-defects.expanded";

const ALL_ITEMS: NavItem[] = [
  { href: "/overview", label: "Overview", icon: Gauge },
  { href: "/all-defects", label: "All Defects", icon: Bug, scope: "alldefects" },
  { href: "/ops", label: "OPS", icon: Wrench, scope: "ops" },
  { href: "/", label: "Customer Defects", icon: LayoutDashboard, scope: "eac" },
  { href: "/automation", label: "Automation Defects", icon: Bot, scope: "automation" },
  { href: "/fr/poc", label: "Feature Requests", icon: ClipboardList, scope: "fr" },
  { href: "/security", label: "Vulnerabilities", icon: ShieldAlert, scope: "sec" },
  { href: "/alerts", label: "Alerts", icon: Siren, scope: "alerts" },
  { href: "/incidents", label: "Incidents", icon: Flame, scope: "incidents" },
  {
    href: PDA_HREF,
    label: "Product Defect Analysis",
    icon: Microscope,
    flag: "pdaDashboard",
  },
  { href: "/tenants", label: "Tenant Health", icon: HeartPulse, flag: "tenantDashboard" },
  { href: "/definitions", label: "Priority Definitions/SLAs", icon: BookOpen },
  { href: "/settings", label: "Settings", icon: Settings },
];

export function Nav() {
  const pathname = usePathname();
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [components, setComponents] = useState<ComponentNavEntry[]>([]);
  const [pdaOpen, setPdaOpen] = useState(false);

  /** True on the overall Product Defect Analysis view or any component page. */
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

  // Restored in an effect rather than in the `useState` initialiser so the
  // server render and the first client render agree on `false`.
  useEffect(() => {
    setPdaOpen(window.localStorage.getItem(PDA_OPEN_KEY) === "1");
  }, []);

  // Declared after the restore above so entering the section always wins over
  // a remembered "collapsed": landing on a component page with its own entry
  // hidden would leave the reader with no sense of where they are.
  useEffect(() => {
    if (inPda) setPdaOpen(true);
  }, [inPda]);

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

  const togglePda = useCallback(() => {
    setPdaOpen((open) => {
      const next = !open;
      window.localStorage.setItem(PDA_OPEN_KEY, next ? "1" : "0");
      return next;
    });
  }, []);

  const items = ALL_ITEMS.filter((item) => {
    if (!config) return true; // before config loads, show everything
    if (item.scope) return config.dashboards?.[item.scope] !== false;
    if (item.flag) return config[item.flag] !== false;
    return true;
  });

  return (
    <aside className="hidden md:flex flex-col w-56 shrink-0 border-r border-border bg-bg-muted">
      <div className="flex items-center gap-2 px-4 h-14 border-b border-border">
        <div className="h-7 w-7 rounded bg-accent/20 border border-accent/40 flex items-center justify-center">
          <Activity className="h-4 w-4 text-accent" />
        </div>
        <div className="text-sm font-semibold">JIRA Manager</div>
      </div>
      <nav className="flex-1 px-2 py-3 space-y-1 overflow-y-auto scroll-thin">
        {items.map((item) => {
          // Only the Product Defect Analysis parent has children today, and
          // only once the report actually carries per-component analyses — a
          // disclosure that opens onto nothing is worse than no disclosure.
          const children = item.href === PDA_HREF ? components : [];
          if (children.length === 0) {
            return <NavLink key={item.href} item={item} active={pathname === item.href} />;
          }
          return (
            <div key={item.href}>
              <div className="flex items-center gap-0.5">
                <NavLink item={item} active={pathname === item.href} className="flex-1 min-w-0" />
                <button
                  type="button"
                  onClick={togglePda}
                  aria-expanded={pdaOpen}
                  // Referenced only while the list exists — a dangling
                  // aria-controls is worse than none for a screen reader.
                  aria-controls={pdaOpen ? "nav-pda-children" : undefined}
                  aria-label={`${pdaOpen ? "Collapse" : "Expand"} ${item.label} components`}
                  className="shrink-0 rounded p-1.5 text-fg-subtle hover:text-fg hover:bg-bg-card/50 transition-colors"
                >
                  <ChevronDown
                    className={cn("h-3.5 w-3.5 transition-transform", pdaOpen ? "rotate-0" : "-rotate-90")}
                  />
                </button>
              </div>
              {pdaOpen && (
                <ul id="nav-pda-children" className="mt-0.5 ml-4 pl-2 border-l border-border space-y-0.5">
                  {children.map((c) => {
                    const href = `${PDA_HREF}/${c.slug}`;
                    const active = pathname === href;
                    return (
                      <li key={c.slug}>
                        <Link
                          href={href}
                          aria-current={active ? "page" : undefined}
                          title={`${c.component} · ${c.defectCount} defects`}
                          className={cn(
                            "flex items-center gap-2 pl-2 pr-2 py-1 rounded text-[13px] transition-colors",
                            active
                              ? "bg-bg-card text-fg border border-border-strong"
                              : "text-fg-muted hover:text-fg hover:bg-bg-card/50",
                          )}
                        >
                          <span className="truncate">{c.component}</span>
                          <span className="ml-auto shrink-0 font-mono text-[10px] text-fg-subtle">
                            {c.defectCount}
                          </span>
                        </Link>
                      </li>
                    );
                  })}
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
 * overall view, never merely toggle.
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
