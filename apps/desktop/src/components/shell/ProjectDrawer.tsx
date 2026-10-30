import { Button } from "@/components/ui/button";
import { t } from "../../i18n";
import { GearSix, House, X } from "../primitives/icons";
import { useRef } from "react";

import { ModalSurface } from "../primitives";

interface ProjectDrawerActions {
  onClose: () => void;
  onHome?: () => void;
  onOpenSettings?: () => void;
  navigationDisabled?: boolean;
}

export function ProjectDrawer({ onClose, onHome, onOpenSettings,
  navigationDisabled = false }: ProjectDrawerActions) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const closeAndRun = (action: () => void) => {
    onClose();
    action();
  };
  return (
    <ModalSurface
      id="project-drawer"
      title={t("项目导航")}
      className="flex h-[min(800px,calc(100dvh-32px))] w-[min(440px,calc(100vw-32px))] sm:max-w-none flex-col gap-4"
      onClose={onClose}
      initialFocusRef={closeRef}
    >
      <Button ref={closeRef} type="button" variant="ghost" size="icon-sm" className="absolute right-3 top-3" aria-label={t("关闭项目抽屉")} onClick={onClose}>
        <X size={18} />
      </Button>
      <fieldset disabled={navigationDisabled} className="contents">
      {onHome ? <nav aria-label={t("工作区")} className="flex shrink-0">
        <Button type="button" variant="ghost" size="sm" className="w-full justify-start" onClick={() => closeAndRun(onHome)}>
          <House size={16} />{t("项目中心")}
        </Button>
      </nav> : null}
      </fieldset>
      {onOpenSettings ? <div className="mt-auto shrink-0 border-t border-border/60 pt-3">
        <Button type="button" variant="ghost" className="w-full justify-start" onClick={() => closeAndRun(onOpenSettings)}>
          <GearSix size={16} />{t("设置与引擎")}
        </Button>
      </div> : null}
    </ModalSurface>
  );
}
