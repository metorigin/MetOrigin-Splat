// Adapted from Jan containers/Card.tsx. Copyright Menlo Research. Apache-2.0.
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function SettingsSection({ title, description, children, className }: {
  title?: string;
  description?: string;
  children: ReactNode;
  className?: string;
}) {
  return <section className={cn("w-full rounded-lg bg-card p-4 text-sm text-foreground", className)}>
    {title && <h3 className="mb-4 text-base font-medium">{title}</h3>}
    {description && <p className="mb-4 text-xs leading-relaxed text-muted-foreground">{description}</p>}
    {children}
  </section>;
}
