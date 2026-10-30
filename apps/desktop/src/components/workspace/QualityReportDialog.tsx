import { ModalSurface } from "@/components/primitives";
import { SpinnerGap, Warning } from "@/components/primitives/icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { getLocale, localizeMessage, t } from "@/i18n";
import type { ArtifactSummary } from "@/types";
import { useRef } from "react";

export function QualityReportDialog({ open, artifacts, busy, pipelineBusy, onClose, onConfirm }: {
  open: boolean; artifacts: ArtifactSummary | null; busy: boolean; pipelineBusy: boolean;
  onClose: () => void; onConfirm: () => Promise<void>;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  return <>
      {open && (
        <ModalSurface
          id="quality-risk-dialog"
          title={t("质量评估结果")}
          titleHidden
          className="quality-risk-dialog w-[min(640px,calc(100vw-2rem))] p-6"
          ariaDescribedBy="quality-risk-description"
          busy={busy}
          onClose={() => onClose()}
          initialFocusRef={cancelRef}
        >
            <h2 aria-hidden="true">{t("质量评估结果")}</h2>
            <p id="quality-risk-description" className="sr-only">
              {t("查看当前模型的已测量指标、检查结果与继续训练前的风险。")}</p>
            <section className="quality-result-metrics" aria-label={t("质量指标")}>
              <div><span>{t("已注册图像")}</span><strong>{artifacts?.registered_images ?? "—"} / {artifacts?.total_images ?? "—"}</strong></div>
              <div><span>{t("场景点数")}</span><strong>{(artifacts?.splat_count ?? artifacts?.sparse_points)?.toLocaleString(getLocale()) ?? "—"}</strong></div>
              <div><span>{t("重投影误差")}</span><strong>{artifacts?.mean_reprojection_error != null ? `${artifacts.mean_reprojection_error.toFixed(3)} px` : "—"}</strong></div>
            </section>
            <section className="quality-recommendations">
              <h3>{t("模型检查")}</h3>
              {artifacts?.colmap_validation?.checks.length ? artifacts.colmap_validation.checks.map((check) => <article key={check.name}><div><strong>{localizeMessage(check.name)}</strong><span>{localizeMessage(check.detail)}</span></div><Badge variant={check.passed ? "success" : "destructive"}>{check.passed ? t("通过") : t("需处理")}</Badge></article>) : <p>{t("质量报告尚未生成。完成相机重建后会在这里显示实际检查结果。")}</p>}
            </section>
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="outline"
                ref={cancelRef}
                type="button"

                disabled={busy}
                onClick={() => onClose()}
              >
                {t("关闭")}</Button>
              {artifacts?.colmap_validation?.decision === "requires_confirmation" ? <Button variant="default"
                type="button"

                disabled={busy || pipelineBusy}
                onClick={() => void onConfirm()}
              >
                {busy ? <SpinnerGap size={16} className="spin" /> : <Warning size={16} />}
                {t("确认风险并继续")}</Button> : null}
            </div>
        </ModalSurface>
      )}
  </>;
}
