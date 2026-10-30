import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/** Edge-aligned desktop navigation/header/sidebar/content regions; existing state owns navigation. */
export function DesktopAppShell({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("desktop-app-shell flex h-dvh w-full flex-col overflow-hidden bg-background text-foreground", className)} {...props} />;
}
