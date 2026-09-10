import { t } from "../../i18n";
import { Trash, WarningCircle, X } from "../primitives/icons";
import { useRef } from "react";

import type { ProjectInfo } from "../../types";
import { ModalSurface } from "../primitives";

export function DeleteProjectDialog({
  project,
  busy,
  onCancel,
  onConfirm,
}: {
  project: ProjectInfo;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  return (
    <ModalSurface
      id={`delete-project-${project.id}`}
      title={t("永久删除项目")}
      titleHidden
      className="delete-project-dialog"
      role="alertdialog"
      busy={busy}
      initialFocusRef={cancelRef}
      onClose={onCancel}
    >
        <header>
          <span className="danger-dialog-icon"><WarningCircle size={22} weight="fill" /></span>
          <div>
            <h2 aria-hidden="true">{t("永久删除项目")}</h2>
            <p>{t("项目素材、重建结果、Checkpoint、日志和 PLY 都会被删除。")}</p>
          </div>
          <button type="button" className="icon-button" onClick={onCancel} disabled={busy} aria-label={t("关闭删除项目对话框")}><X size={18} /></button>
        </header>
        <div className="delete-project-body">
          <dl>
            <div><dt>{t("项目")}</dt><dd>{project.name}</dd></div>
            <div><dt>{t("目录")}</dt><dd title={project.path}>{project.path}</dd></div>
            <div><dt>{t("删除范围")}</dt><dd>{t("素材、重建结果、Checkpoint、日志和 PLY")}</dd></div>
          </dl>
          <p className="delete-warning-copy">{t("此操作不可撤销。")}</p>
        </div>
        <footer>
          <button ref={cancelRef} type="button" className="button button-secondary" onClick={onCancel} disabled={busy}>{t("取消")}</button>
          <button type="button" className="button button-danger" disabled={busy} onClick={onConfirm}>
            <Trash size={16} />{busy ? t("正在删除…") : t("永久删除")}
          </button>
        </footer>
    </ModalSurface>
  );
}
