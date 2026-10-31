import {
  Cube,
  SpinnerGap
} from "@/components/primitives/icons";
import { GAUSSIAN_STAGES, TRAINING_PREVIEW_STAGES } from "@/components/workspace/workspacePresentation";
import type { useProjectWorkspace } from "@/hooks/useProjectWorkspace";
import { getLocale, t } from "@/i18n";
import { lazy, Suspense } from "react";

import { AsyncStatus } from "@/components";
import {
  PointCloudPreview
} from "@/components/workspace";

const GaussianSplatPreview = lazy(() => import("./GaussianSplatPreview").then((module) => ({ default: module.GaussianSplatPreview })));
type WorkspaceView = Pick<ReturnType<typeof useProjectWorkspace>, "previewMode" | "selectedStage" | "previewRelativePath" | "previewResource" | "latestCheckpointPath" | "gaussianSourceMissing" | "loadSelectedPreview" | "currentPreviewRequest" | "selectedPreview" | "pipelineBusy">;
export function SceneViewportHost({ workspace, projectId, projectPath }: { workspace: WorkspaceView; projectId: string; projectPath: string }) {
  const { previewMode, selectedStage, previewRelativePath, previewResource, latestCheckpointPath, gaussianSourceMissing, loadSelectedPreview, currentPreviewRequest, selectedPreview, pipelineBusy } = workspace;
  return (
        <section className="preview-panel flex-1 rounded-lg border border-border" tabIndex={-1}>
          {selectedStage && GAUSSIAN_STAGES.includes(selectedStage) && !gaussianSourceMissing ? previewMode ? <div className="preview-empty"><Cube size={40} /><strong>{t("高斯场景预览")}</strong><p>{t("当前为界面设计示例。请在桌面应用中打开项目查看真实模型与训练预览。")}</p></div> : <Suspense fallback={<div className="preview-empty">{t("正在启动高斯渲染器…")}</div>}><GaussianSplatPreview
            key={JSON.stringify([projectId, projectPath])}
            projectId={projectId}
            projectPath={projectPath}
            relativePath={previewRelativePath ?? (TRAINING_PREVIEW_STAGES.includes(selectedStage) ? latestCheckpointPath : "output/scene.ply")}
            live={TRAINING_PREVIEW_STAGES.includes(selectedStage) && previewRelativePath === null}
            running={pipelineBusy}
            showToolbar={false}
          /></Suspense> : <>{currentPreviewRequest && previewResource.resource.status !== "stale" && <AsyncStatus
            resource={previewResource.resource}
            label={t("真实产物预览")}
            empty={selectedPreview?.kind === "frame" && selectedPreview.value.items.length === 0}
            onRetry={() => void loadSelectedPreview()}
          />}
          {currentPreviewRequest && previewResource.resource.status === "loading" ? <div className="preview-empty"><SpinnerGap size={35} className="spin" /><strong>{t("正在读取真实产物")}</strong><span>{t("解析完成后将上传到 GPU。")}</span></div>
            : selectedPreview?.kind === "sparse" && selectedPreview.value.points.length > 0 ? <PointCloudPreview points={selectedPreview.value.points} cameras={selectedPreview.value.cameras} label={t("{0} 稀疏点 · {1} 相机", selectedPreview.value.point_count.toLocaleString(getLocale()), selectedPreview.value.registered_images)} showToolbar={false} />
              : selectedPreview?.kind === "frame" && selectedPreview.value.items.length > 0 ? <div className="frame-contact-sheet">{selectedPreview.value.items.map((item) => <img key={item.relative_path} src={item.data_url} width={item.width} height={item.height} style={{ height: "auto" }} alt={t("抽取帧缩略图")} />)}<span>{t("从")}{selectedPreview.value.total_frames} {t("帧中均匀显示")}{selectedPreview.value.items.length} {t("帧")}</span></div>
                : <div className="preview-empty preview-scene-placeholder"><span className="empty-scene-icon"><Cube size={36} /></span><strong>{t("预览尚未生成")}</strong><span>{t("选择已完成阶段后，将在此读取真实产物。")}</span></div>}</>}
        </section>
  );
}
