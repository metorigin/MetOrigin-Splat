import { Trash, WarningCircle, X } from "@phosphor-icons/react";
import { useEffect, useRef } from "react";

import type { ProjectInfo } from "../../types";

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

  useEffect(() => {
    cancelRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onCancel();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [busy, onCancel, project.id]);

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !busy) onCancel();
    }}>
      <section className="delete-project-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-project-title">
        <header>
          <span className="danger-dialog-icon"><WarningCircle size={22} weight="fill" /></span>
          <div>
            <h2 id="delete-project-title">永久删除项目</h2>
            <p>项目素材、重建结果、Checkpoint、日志和 PLY 都会被删除。</p>
          </div>
          <button type="button" className="icon-button" onClick={onCancel} disabled={busy} aria-label="关闭删除项目对话框"><X size={18} /></button>
        </header>
        <div className="delete-project-body">
          <dl>
            <div><dt>项目</dt><dd>{project.name}</dd></div>
            <div><dt>目录</dt><dd title={project.path}>{project.path}</dd></div>
            <div><dt>删除范围</dt><dd>素材、重建结果、Checkpoint、日志和 PLY</dd></div>
          </dl>
          <p className="delete-warning-copy">此操作不可撤销。</p>
        </div>
        <footer>
          <button ref={cancelRef} type="button" className="button button-secondary" onClick={onCancel} disabled={busy}>取消</button>
          <button type="button" className="button button-danger" disabled={busy} onClick={onConfirm}>
            <Trash size={16} />{busy ? "正在删除…" : "永久删除"}
          </button>
        </footer>
      </section>
    </div>
  );
}
