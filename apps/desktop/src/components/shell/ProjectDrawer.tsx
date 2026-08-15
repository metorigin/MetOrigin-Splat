import { X } from "@phosphor-icons/react";
import { useRef } from "react";

import { ModalSurface } from "../primitives";
import { ProjectNavigator } from "./ProjectNavigator";
import type { ProjectNavigatorProps } from "./ProjectNavigator";

export function ProjectDrawer({ onClose, ...navigatorProps }: ProjectNavigatorProps & { onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  return (
    <ModalSurface
      id="project-drawer"
      title="全部项目"
      className="project-drawer"
      onClose={onClose}
      initialFocusRef={closeRef}
    >
      <div className="project-drawer-toolbar">
        <p>搜索、打开或管理最近项目；路径状态会在后台逐项更新。</p>
        <button ref={closeRef} type="button" className="icon-button" aria-label="关闭项目抽屉" onClick={onClose}>
          <X size={18} />
        </button>
      </div>
      <ProjectNavigator {...navigatorProps} onNavigate={onClose} />
    </ModalSurface>
  );
}
