"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import {
  LayoutDashboard,
  Settings,
  Star,
  Activity,
  ClipboardList,
  ShieldAlert,
  BookOpen,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { AppConfig, Scope } from "@/types/triage";

interface NavItem {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
  /** If set, the item is shown only when config.dashboards[scope] is true. */
  scope?: Scope;
}

const ALL_ITEMS: NavItem[] = [
  { href: "/", label: "Customer Dashboard", icon: LayoutDashboard, scope: "eac" },
  { href: "/fr", label: "FR Dashboard", icon: ClipboardList, scope: "fr" },
  { href: "/security", label: "Security Dashboard", icon: ShieldAlert, scope: "sec" },
  { href: "/p0", label: "White-glove Customers", icon: Star },
  { href: "/definitions", label: "Priority Definitions/SLAs", icon: BookOpen },
  { href: "/settings", label: "Settings", icon: Settings },
];

export function Nav() {
  const pathname = usePathname();
  const [config, setConfig] = useState<AppConfig | null>(null);

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

  const items = ALL_ITEMS.filter((item) => {
    if (!item.scope) return true;
    if (!config) return true; // before config loads, show everything
    return config.dashboards?.[item.scope] !== false;
  });

  return (
    <aside className="hidden md:flex flex-col w-56 shrink-0 border-r border-border bg-bg-muted">
      <div className="flex items-center gap-2 px-4 h-14 border-b border-border">
        <div className="h-7 w-7 rounded bg-accent/20 border border-accent/40 flex items-center justify-center">
          <Activity className="h-4 w-4 text-accent" />
        </div>
        <div className="text-sm font-semibold">JIRA Manager</div>
      </div>
      <nav className="flex-1 px-2 py-3 space-y-1">
        {items.map((item) => {
          const Icon = item.icon;
          const active = pathname === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-2 px-3 py-2 rounded text-sm transition-colors",
                active
                  ? "bg-bg-card text-fg border border-border-strong"
                  : "text-fg-muted hover:text-fg hover:bg-bg-card/50",
              )}
            >
              <Icon className="h-4 w-4" />
              {item.label}
            </Link>
          );
        })}
      </nav>
      <div className="px-4 py-3 border-t border-border text-[11px] text-fg-subtle">
        v0.1.0 · {new Date().toISOString().slice(0, 10)}
      </div>
    </aside>
  );
}
