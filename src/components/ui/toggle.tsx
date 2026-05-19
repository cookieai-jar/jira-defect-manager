"use client";

import { cn } from "@/lib/utils";

interface Props {
  checked: boolean;
  onChange: (next: boolean) => void;
  label?: string;
  description?: string;
  disabled?: boolean;
}

export function Toggle({ checked, onChange, label, description, disabled }: Props) {
  return (
    <label
      className={cn(
        "flex items-start justify-between gap-3 py-2",
        disabled && "opacity-50 cursor-not-allowed",
      )}
    >
      <div className="min-w-0">
        {label && <div className="text-sm font-medium text-fg">{label}</div>}
        {description && (
          <div className="text-xs text-fg-muted mt-0.5">{description}</div>
        )}
      </div>
      <button
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => !disabled && onChange(!checked)}
        className={cn(
          "shrink-0 inline-flex h-5 w-9 items-center rounded-full transition-colors border",
          checked
            ? "bg-accent border-accent"
            : "bg-bg-muted border-border-strong",
          disabled ? "cursor-not-allowed" : "cursor-pointer",
        )}
      >
        <span
          className={cn(
            "inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform",
            checked ? "translate-x-5" : "translate-x-0.5",
          )}
        />
      </button>
    </label>
  );
}
