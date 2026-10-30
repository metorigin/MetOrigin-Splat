import type { ReactNode, RefCallback } from "react";
import { PanelLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { t } from "../../i18n";
import { isMacPlatform } from "../../lib/platformShortcuts";
import { isDesktopRuntime } from "../../services/desktop";

interface DesktopTitlebarProps {
  sidebarWidth: number;
  title?: string;
  children?: ReactNode;
  headerTargetRef?: RefCallback<HTMLDivElement>;
  sidebarCollapsed: boolean;
  compact: boolean;
  drawerOpen: boolean;
  navigationDisabled: boolean;
  onToggleSidebar: () => void;
}

export function DesktopTitlebar({ title, children, headerTargetRef, sidebarWidth, sidebarCollapsed, compact, drawerOpen, navigationDisabled,
  onToggleSidebar }: DesktopTitlebarProps) {
  const nativeMac = isDesktopRuntime() && isMacPlatform();
  const sidebarLabel = compact ? t("打开项目导航") : sidebarCollapsed ? t("展开项目栏") : t("折叠项目栏");

  return (
    <header data-tauri-drag-region className="relative flex h-12 shrink-0 select-none border-b border-border/60 bg-background">
      <div data-window-region="navigation" data-tauri-drag-region style={{ width: sidebarCollapsed ? "auto" : sidebarWidth }} className={cn("flex h-full shrink-0 items-center justify-end", sidebarCollapsed ? "bg-background pr-1" : "border-r border-border/60 bg-sidebar pr-2", nativeMac ? "pl-[84px]" : "pl-2")}>
        <Tooltip><TooltipTrigger asChild>
          <Button id="desktop-sidebar-toggle" variant="ghost" size="icon-sm" className="size-8 rounded-full text-muted-foreground" onClick={onToggleSidebar}
            disabled={navigationDisabled} aria-label={sidebarLabel} aria-expanded={compact ? drawerOpen : !sidebarCollapsed}
            aria-haspopup={compact ? "dialog" : undefined}>
            <PanelLeft className="size-[18px]" size={18} strokeWidth={1.75} />
          </Button>
        </TooltipTrigger><TooltipContent side="bottom">{sidebarLabel}</TooltipContent></Tooltip>
      </div>
      <div ref={headerTargetRef} data-window-region="page-header" data-tauri-drag-region className="flex h-full min-w-0 flex-1 items-center bg-background">
        {title ? <h1 data-tauri-drag-region className="min-w-0 flex-1 truncate px-4 text-sm font-medium">{title}</h1> : null}
        {children}
      </div>
    </header>
  );
}
