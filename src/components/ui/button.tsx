import * as React from "react";
import { cn } from "@/lib/utils";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md";

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

const variants: Record<Variant, string> = {
  primary:
    "bg-accent text-white hover:bg-accent-hover disabled:bg-accent/40 disabled:cursor-not-allowed",
  secondary:
    "bg-bg-card border border-border-strong text-fg hover:border-fg-muted disabled:opacity-50",
  ghost: "bg-transparent text-fg-muted hover:text-fg hover:bg-bg-muted",
  danger: "bg-danger/90 text-white hover:bg-danger",
};

const sizes: Record<Size, string> = {
  sm: "h-7 px-2.5 text-xs",
  md: "h-9 px-3.5 text-sm",
};

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = "primary", size = "md", ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      className={cn(
        "inline-flex items-center justify-center gap-1.5 rounded font-medium transition-colors focus:outline-none focus:ring-1 focus:ring-accent disabled:cursor-not-allowed",
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    />
  );
});
