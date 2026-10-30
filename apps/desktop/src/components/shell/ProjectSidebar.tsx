import { SidebarSurface, SidebarMenuButton, SidebarResizeRail, DEFAULT_SIDEBAR_WIDTH } from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { ReactElement } from "react";
import { t } from "../../i18n";
import { GearSix, House } from "../primitives/icons";
import { useCallback, useEffect, useRef } from "react";

import { ProjectDrawer } from "./ProjectDrawer";

function SidebarTooltip({ label, children }: { label: string; children: ReactElement }) {
  return <Tooltip><TooltipTrigger asChild>{children}</TooltipTrigger><TooltipContent side="right">{label}</TooltipContent></Tooltip>;
}

interface ProjectSidebarProps {
  activeProjectPath: string | null;
  collapsed: boolean;
  width?: number;
  navigationDisabled?: boolean;
  onWidthChange?: (width: number) => void;
  onDraggingChange?: (dragging: boolean) => void;
  viewportCompact?: boolean;
  drawerOpen?: boolean;
  onDrawerOpenChange?: (open: boolean) => void;
  onHome: () => void;
  onOpenSettings?: () => void;
}

export function ProjectSidebar({
  activeProjectPath,
  collapsed,
  width = DEFAULT_SIDEBAR_WIDTH,
  navigationDisabled = false,
  onWidthChange,
  onDraggingChange,
  viewportCompact = false,
  drawerOpen = false,
  onDrawerOpenChange,
  onHome,
  onOpenSettings = () => undefined,
}: ProjectSidebarProps) {
  const setDrawerOpen = useCallback((open: boolean) => {
    onDrawerOpenChange?.(open);
  }, [onDrawerOpenChange]);
  const previousCompact = useRef(viewportCompact);
  useEffect(() => {
    if (previousCompact.current && !viewportCompact && drawerOpen) setDrawerOpen(false);
    previousCompact.current = viewportCompact;
  }, [drawerOpen, setDrawerOpen, viewportCompact]);
  const effectiveCollapsed = collapsed || viewportCompact;

  return (
    <TooltipProvider>
    {!effectiveCollapsed && <SidebarSurface style={{ width }} className="project-sidebar px-3">
      <fieldset disabled={navigationDisabled} className="contents">
      <nav className="flex shrink-0 items-center gap-1 pt-1" aria-label={t("工作区")}>
        <SidebarTooltip label={t("项目中心")}><SidebarMenuButton active={!activeProjectPath} className={`h-8 min-w-0 flex-1 justify-start rounded-md px-2 text-[13px] ${!activeProjectPath ? "bg-sidebar-accent text-sidebar-accent-foreground" : "text-muted-foreground"}`} onClick={onHome} aria-label={t("项目中心")} aria-current={!activeProjectPath ? "page" : undefined}>
          <House size={16} />
          <span>{t("项目中心")}</span>
        </SidebarMenuButton></SidebarTooltip>
      </nav>

      </fieldset>
      <div className="mt-auto shrink-0 py-3">
        <SidebarTooltip label={t("设置与引擎")}><SidebarMenuButton className="h-8 w-full justify-start rounded-md px-2 text-[13px] text-muted-foreground" onClick={onOpenSettings} aria-label={t("设置与引擎")}>
          <GearSix size={16} />
          <span>{t("设置与引擎")}</span>
        </SidebarMenuButton></SidebarTooltip>
      </div>

      {onWidthChange ? <SidebarResizeRail width={width} onWidthChange={onWidthChange} onDraggingChange={onDraggingChange} /> : null}
    </SidebarSurface>}

      {drawerOpen ? (
        <ProjectDrawer onClose={() => setDrawerOpen(false)}
          navigationDisabled={navigationDisabled} onHome={onHome} onOpenSettings={onOpenSettings} />
      ) : null}
    </TooltipProvider>
  );
}
