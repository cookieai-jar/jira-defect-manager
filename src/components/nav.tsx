"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboard, Settings, Star, Activity } from "lucide-react";
import { cn } from "@/lib/utils";

const ITEMS = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/p0", label: "P0 Customers", icon: Star },
  { href: "/settings", label: "Settings", icon: Settings },
];

export function Nav() {
  const pathname = usePathname();
  return (
    <aside className="hidden md:flex flex-col w-56 shrink-0 border-r border-border bg-bg-muted">
      <div className="flex items-center gap-2 px-4 h-14 border-b border-border">
        <div className="h-7 w-7 rounded bg-accent/20 border border-accent/40 flex items-center justify-center">
          <Activity className="h-4 w-4 text-accent" />
        </div>
        <div className="text-sm font-semibold">Customer Triage</div>
      </div>
      <nav className="flex-1 px-2 py-3 space-y-1">
        {ITEMS.map((item) => {
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
