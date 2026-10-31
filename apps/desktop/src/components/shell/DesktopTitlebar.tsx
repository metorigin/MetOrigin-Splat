import type { ReactNode, RefCallback } from "react";
import { PanelLeft } from "lucide-react";
import appIcon from "@/assets/app-icon.png";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { t } from "../../i18n";
import { isMacPlatform, isWindowsPlatform } from "../../lib/platformShortcuts";
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
  const expanded = !sidebarCollapsed && !compact;
  const sidebarLabel = compact ? t("打开项目导航") : sidebarCollapsed ? t("展开项目栏") : t("折叠项目栏");

  return (
    <header data-tauri-drag-region className="relative flex h-12 shrink-0 select-none border-b border-border/60 bg-background">
      <div data-window-region="navigation" data-tauri-drag-region style={{ width: expanded ? sidebarWidth : "auto" }} className={cn("flex h-full min-w-0 shrink-0 items-center justify-end", expanded ? "border-r border-border/60 bg-sidebar pr-2" : "bg-background pr-1", nativeMac ? "pl-[84px]" : expanded ? "pl-5" : "pl-2")}>
        {expanded && isWindowsPlatform() ? (
          <div data-window-region="brand" data-tauri-drag-region className="mr-2 flex min-w-0 flex-1 items-center gap-2 text-sidebar-foreground">
            <img data-tauri-drag-region src={appIcon} alt="" aria-hidden="true" draggable={false} width={28} height={28} className="size-7 shrink-0 object-contain" />
            <span data-tauri-drag-region className="truncate py-0.5 text-[14px] font-medium leading-5">MetOrigin Splat</span>
          </div>
        ) : null}
        <Tooltip><TooltipTrigger asChild>
          <Button id="desktop-sidebar-toggle" variant="ghost" size="icon-sm" className="size-8 shrink-0 rounded-full text-muted-foreground" onClick={onToggleSidebar}
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
