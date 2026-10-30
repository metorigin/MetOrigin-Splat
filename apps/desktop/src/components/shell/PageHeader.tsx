/* Jan containers/HeaderPage.tsx, b8d58255baf6d9e870025d3f0c60a5b80a63143b.
 * Apache-2.0, Copyright 2025 Menlo Research. Local: semantic header and no Jan business/store. */
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function PageHeader({ title, actions, className }: { title?: string; actions?: ReactNode; className?: string }) {
  return <header className={cn("flex min-h-15 shrink-0 flex-wrap items-center justify-between gap-3 px-5 py-3", className)}>
    {title ? <h1 className="min-w-0 flex-1 text-base font-medium tracking-tight">{title}</h1> : null}
    {actions ? <div className="flex min-w-0 flex-wrap items-center gap-2">{actions}</div> : null}
  </header>;
}
