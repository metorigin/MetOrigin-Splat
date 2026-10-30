// Adapted from Jan containers/Card.tsx CardItem. Copyright Menlo Research. Apache-2.0.
import type { ReactNode } from "react";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

export function SettingsRow({ label, description, htmlFor, children, column = false }: {
  label: string;
  description?: string;
  htmlFor?: string;
  children: ReactNode;
  column?: boolean;
}) {
  return <div className={cn("mt-2 flex items-center justify-between gap-8 border-b border-border/40 pb-3 first:mt-0 last:border-none last:pb-0 max-sm:flex-col max-sm:items-stretch max-sm:gap-3", column && "flex-col items-stretch gap-3")}>
    <div className="min-w-0 space-y-1.5">
      {htmlFor ? <Label htmlFor={htmlFor} className="font-medium leading-relaxed">{label}</Label> : <p className="font-medium">{label}</p>}
      {description && <p className="text-xs leading-relaxed text-muted-foreground">{description}</p>}
    </div>
    <div className={cn("min-w-0 shrink-0 max-sm:w-full", column && "w-full")}>{children}</div>
  </div>;
}
