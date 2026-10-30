import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
    <ModalSurface id="checkpoint-drawer" title={t("Checkpoint 管理器")} titleHidden className="checkpoint-drawer grid h-[min(640px,calc(100dvh-3rem))] w-[min(560px,calc(100vw-2rem))] grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden p-0" onClose={onClose} initialFocusRef={closeRef}>
      <header><div><strong>{t("Checkpoint 管理器")}</strong><span>{t("Brush PLY 几何恢复点，不包含优化器状态")}</span></div><Button variant="ghost" size="icon-sm" ref={closeRef}  type="button" onClick={onClose} aria-label={t("关闭 Checkpoint 管理器")}><X size={17} /></Button></header>
      <div className="checkpoint-list">
        {checkpoints.length === 0 ? <div className="checkpoint-empty">{t("尚未生成合法 Checkpoint")}</div> : checkpoints.map((checkpoint) => (
          <article key={checkpoint.iteration} className={checkpoint.current ? "is-current" : ""}>
            <div className="checkpoint-heading"><strong>{checkpoint.iteration.toLocaleString(getLocale())} step</strong>{checkpoint.current && <Badge variant="secondary">{t("当前使用")}</Badge>}</div>
            <dl><div><dt>{t("大小")}</dt><dd>{formatBytes(checkpoint.size_bytes)}</dd></div><div><dt>Splat</dt><dd>{checkpoint.vertex_count.toLocaleString(getLocale())}</dd></div><div><dt>{t("版本")}</dt><dd>Brush {checkpoint.brush_version}</dd></div><div><dt>{t("状态")}</dt><dd><Badge variant={checkpoint.valid ? "success" : "destructive"}>{checkpoint.valid ? t("已验证") : t("无效")}</Badge></dd></div></dl>
            <div className="checkpoint-actions"><Button variant="outline" size="sm" type="button" onClick={() => onPreview(checkpoint)}><Eye size={14} />{t("预览")}</Button><Button variant="outline" size="sm" type="button" onClick={() => onRestore(checkpoint)} disabled={checkpoint.current || !checkpoint.valid}><ArrowCounterClockwise size={14} />{t("恢复")}</Button><Button variant="ghost" size="sm" type="button" onClick={() => onOpen(checkpoint)}><FolderOpen size={14} />{t("定位")}</Button><Button variant="ghost" size="sm" className="text-destructive" type="button" onClick={() => onDelete(checkpoint)} disabled={checkpoint.current}><Trash size={14} />{t("删除")}</Button></div>
          </article>
        ))}
      </div>
    </ModalSurface>
  );
}
