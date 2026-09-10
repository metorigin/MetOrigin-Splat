import { getLocale, t } from "../../i18n";
import { ArrowCounterClockwise, Eye, FolderOpen, Trash, X } from "../primitives/icons";
import { useRef } from "react";

import type { CheckpointSummary } from "../../types";
import { ModalSurface } from "../primitives";

function formatBytes(bytes: number) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

export function CheckpointDrawer({ checkpoints, onClose, onPreview, onRestore, onDelete, onOpen }: {
  checkpoints: CheckpointSummary[];
  onClose: () => void;
  onPreview: (checkpoint: CheckpointSummary) => void;
  onRestore: (checkpoint: CheckpointSummary) => void;
  onDelete: (checkpoint: CheckpointSummary) => void;
  onOpen: (checkpoint: CheckpointSummary) => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  return (
    <ModalSurface id="checkpoint-drawer" title={t("Checkpoint 管理器")} titleHidden className="checkpoint-drawer" onClose={onClose} initialFocusRef={closeRef}>
      <header><div><strong>{t("Checkpoint 管理器")}</strong><span>{t("Brush PLY 几何恢复点，不包含优化器状态")}</span></div><button ref={closeRef} className="icon-button" type="button" onClick={onClose} aria-label={t("关闭 Checkpoint 管理器")}><X size={17} /></button></header>
      <div className="checkpoint-list">
        {checkpoints.length === 0 ? <div className="checkpoint-empty">{t("尚未生成合法 Checkpoint")}</div> : checkpoints.map((checkpoint) => (
          <article key={checkpoint.iteration} className={checkpoint.current ? "is-current" : ""}>
            <div className="checkpoint-heading"><strong>{checkpoint.iteration.toLocaleString(getLocale())} step</strong>{checkpoint.current && <span>{t("当前使用")}</span>}</div>
            <dl><div><dt>{t("大小")}</dt><dd>{formatBytes(checkpoint.size_bytes)}</dd></div><div><dt>Splat</dt><dd>{checkpoint.vertex_count.toLocaleString(getLocale())}</dd></div><div><dt>{t("版本")}</dt><dd>Brush {checkpoint.brush_version}</dd></div><div><dt>{t("状态")}</dt><dd className={checkpoint.valid ? "analysis-ok" : "analysis-blocked"}>{checkpoint.valid ? t("已验证") : t("无效")}</dd></div></dl>
            <div className="checkpoint-actions"><button type="button" onClick={() => onPreview(checkpoint)}><Eye size={14} />{t("预览")}</button><button type="button" onClick={() => onRestore(checkpoint)} disabled={checkpoint.current || !checkpoint.valid}><ArrowCounterClockwise size={14} />{t("恢复")}</button><button type="button" onClick={() => onOpen(checkpoint)}><FolderOpen size={14} />{t("定位")}</button><button type="button" onClick={() => onDelete(checkpoint)} disabled={checkpoint.current}><Trash size={14} />{t("删除")}</button></div>
          </article>
        ))}
      </div>
    </ModalSurface>
  );
}
