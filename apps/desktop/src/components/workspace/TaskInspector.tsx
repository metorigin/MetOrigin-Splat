import {
  ArrowClockwise,
  CaretDown,
  Database,
  FolderOpen,
  ImageSquare,
  SpinnerGap,
  Warning,
  X
} from "@/components/primitives/icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Progress } from "@/components/ui/progress";
import type { useProjectWorkspace } from "@/hooks/useProjectWorkspace";
import { getLocale, localizeMessage, t } from "@/i18n";

import { getStageLabel } from "@/localization";
import { plyActionState } from "@/pages/projectTimeline";
import type {
  ResourceMetrics
} from "@/types";

type WorkspaceView = Pick<ReturnType<typeof useProjectWorkspace>, "project" | "artifacts" | "checkpoints" | "setCheckpointOpen" | "inspectorOpen" | "setInspectorOpen" | "setActivityOpen" | "qualityAction" | "recoveringStage" | "setQualityDialogOpen" | "qualityAccepting" | "inspectorCloseRef" | "pipelineState" | "workspaceStatus" | "workspaceComplete" | "openOutputDirectory" | "openScenePly" | "currentStageLabel" | "pipelineBusy" | "workspacePaused" | "workspaceFailed" | "overallPercent" | "failedStage" | "failureMessage" | "gpuPercent" | "memory" | "vramPercent" | "cpuPercent" | "recoverFromStage">;
export function TaskInspector({ workspace, metrics }: { workspace: WorkspaceView; metrics: ResourceMetrics | null }) {
  const { project, artifacts, checkpoints, setCheckpointOpen, inspectorOpen, setInspectorOpen, setActivityOpen, qualityAction, recoveringStage, setQualityDialogOpen, qualityAccepting, inspectorCloseRef, pipelineState, workspaceStatus, workspaceComplete, openOutputDirectory, openScenePly, currentStageLabel, pipelineBusy, workspacePaused, workspaceFailed, overallPercent, failedStage, failureMessage, gpuPercent, memory, vramPercent, cpuPercent, recoverFromStage } = workspace;
  const workspaceCancelled = workspaceStatus === "cancelled";
  const registrationLabel = project?.source?.type === "ImageFolder"
    ? t("照片注册率")
    : project?.source?.type === "Video" ? t("视频帧注册率") : t("图像注册率");
  const pointCount = artifacts?.splat_count ?? artifacts?.sparse_points;
  const pointCountLabel = artifacts?.splat_count != null ? t("高斯点数") : t("稀疏点数");
  return (
        <aside className={`workspace-inspector-stack ${inspectorOpen ? "is-mobile-open" : ""}`}>
        <div className="mobile-inspector-heading">
          <strong>{t("预览与质量")}</strong>
          <Button variant="ghost" size="icon-sm" ref={inspectorCloseRef} aria-label={t("关闭预览与质量")} onClick={() => setInspectorOpen(false)}><X size={18} /></Button>
        </div>
        <section className="task-status-card rounded-xl bg-muted/50 p-4" aria-labelledby="task-status-heading">
          <div className="task-status-heading">
            <div><h2 id="task-status-heading">{workspaceFailed ? t("错误与恢复") : workspaceComplete ? t("重建完成") : t("任务监控")}</h2>{!workspaceComplete && <p>{currentStageLabel}</p>}</div>
            {!workspaceComplete && <Badge variant={workspaceFailed ? "destructive" : workspacePaused ? "warning" : "secondary"}>{workspaceFailed ? t("已阻塞") : workspaceCancelled ? t("已取消") : workspacePaused ? t("已暂停") : pipelineBusy ? t("处理中") : t("等待中")}</Badge>}
          </div>
          {workspaceFailed ? (
            <div className="task-error-card" role="alert">
              <div className="task-error-message">
                <strong>{localizeMessage(failureMessage ?? t("任务执行失败，请查看日志了解详情。"))}</strong>
                <p>{failedStage ? t("{0}阶段中断。修复问题后可从此阶段重试。", getStageLabel(failedStage)) : t("未收到失败阶段信息，请先查看活动记录。")}</p>
                <span>{t("失败阶段 · {0}", failedStage ?? t("未知"))}</span>
              </div>
              <div className="task-error-actions">
                <Button variant="default" type="button" onClick={() => failedStage && void recoverFromStage(failedStage, "failed")} disabled={!failedStage || pipelineBusy || recoveringStage !== null}>{t("重试失败阶段")}</Button>
                <Button variant="outline" type="button" onClick={() => setCheckpointOpen(true)} disabled={checkpoints.length === 0}>{t("查看可用恢复点")}</Button>
              </div>
            </div>
          ) : workspaceComplete ? (
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{artifacts?.scene_ply.validated ? t("可预览模型或进入编辑。") : t("可查看输出文件与质量报告。")}</p>
          ) : (
            <div className="task-progress-card">
              <strong>{workspaceCancelled ? t("任务已取消") : workspacePaused ? t("任务已暂停") : currentStageLabel}</strong>
              <b>{overallPercent == null ? "—" : `${overallPercent}%`}</b>
              <Progress value={overallPercent} aria-label={t("任务监控")} className="col-span-full" />
              <p>{workspacePaused ? t("已保留 {0} 个恢复点，继续前将重新校验产物。", checkpoints.length) : `${currentStageLabel} · ${overallPercent == null ? t("等待进度更新") : t("已完成 {0}%", overallPercent)}`}</p>
            </div>
          )}
        </section>

        <section className="quality-panel overflow-hidden rounded-xl border border-border/60 bg-card">
          <div className="panel-title"><span>{t("重建质量")}</span><Button variant="ghost" size="xs" className="rounded-md text-xs text-muted-foreground" type="button" onClick={() => setQualityDialogOpen(true)}>{t("质量检查详情")}</Button></div>
          {artifacts?.colmap_validation && (
            <div className={`colmap-quality-decision decision-${artifacts.colmap_validation.decision}`} role="status">
              <div>
                <strong>
                  {artifacts.colmap_validation.decision === "pass" && t("相机重建检查通过")}
                  {artifacts.colmap_validation.decision === "accepted_with_warning" && t("已接受相机重建风险")}
                  {artifacts.colmap_validation.decision === "requires_confirmation" && t("相机重建待确认")}
                  {artifacts.colmap_validation.decision === "blocked" && t("相机重建未通过")}
                </strong>
                <span title={t("通过验证的特征匹配将图像连接成组，此处显示最大一组占全部输入图像的比例。")}>{t("主要匹配组覆盖 {0}% 图像", (artifacts.colmap_validation.largest_component_coverage * 100).toFixed(1))}</span>
                {artifacts.colmap_validation.automatic_fallbacks_exhausted && <span>{t("自动重建方案已用尽")}</span>}
              </div>
              {artifacts.colmap_validation.decision === "requires_confirmation" && (
                <Button variant="warning"
                  type="button"

                  disabled={pipelineBusy || qualityAccepting}
                  onClick={() => setQualityDialogOpen(true)}
                >
                  <Warning size={16} weight="fill" /> {t("仍然开始训练")}</Button>
              )}
              {artifacts.colmap_validation.decision === "blocked" && (
                <Button variant="outline"
                  type="button"

                  disabled={pipelineBusy || recoveringStage !== null}
                  onClick={() => void recoverFromStage(
                    "FrameExtraction",
                    pipelineState?.stages.FrameExtraction?.status ?? "completed",
                  )}
                >
                  <ArrowClockwise size={16} /> {t("重新准备素材并重建")}</Button>
              )}
            </div>
          )}
          {artifacts?.colmap_attempts && artifacts.colmap_attempts.length > 0 && (
            <Collapsible className="colmap-attempts">
              <CollapsibleTrigger asChild><Button variant="ghost" size="sm" className="h-8 w-full justify-between rounded-md px-0 text-xs text-muted-foreground [&[data-state=open]>svg]:rotate-180">{t("相机重建记录（{0}）", artifacts.colmap_attempts.length)}<CaretDown size={14} /></Button></CollapsibleTrigger>
              <CollapsibleContent asChild><ol>
                {artifacts.colmap_attempts.map((attempt) => (
                  <li key={attempt.id} className={`attempt-${attempt.status}`}>
                    <strong>{attempt.id}</strong>
                    <span>{attempt.matching_strategy} · {attempt.mapper}</span>
                    <span>
                      {attempt.model_info
                        ? t("{0} 张注册 · {1} 点 · {2} px", attempt.model_info.registered_images, attempt.model_info.point_count.toLocaleString(getLocale()), attempt.model_info.mean_reprojection_error.toFixed(3))
                        : localizeMessage(attempt.error) ?? t("未生成可分析模型")}
                    </span>
                  </li>
                ))}
              </ol></CollapsibleContent>
            </Collapsible>
          )}
          <div className="quality-metric-grid">
            <div><strong>{artifacts?.registered_images != null && artifacts.total_images ? `${(artifacts.registered_images / artifacts.total_images * 100).toFixed(1)}%` : "—"}</strong><span>{registrationLabel}</span></div>
            <div><strong>{pointCount?.toLocaleString(getLocale()) ?? "—"}</strong><span>{pointCountLabel}</span></div>
            <div><strong>{artifacts?.mean_reprojection_error != null ? `${artifacts.mean_reprojection_error.toFixed(3)} px` : "—"}</strong><span>{t("重投影误差")}</span></div>
          </div>
          <div className="quality-actions" role="group" aria-label={t("重建产物")}>
            <Button variant="outline"
              type="button"
              size="sm"
              className="h-8 min-w-0 rounded-md px-2 text-xs"
              aria-label={t("打开输出目录")}
              onClick={() => void openOutputDirectory()}
              disabled={qualityAction !== null}
              title={t("打开项目的输出目录")}
            >
              {qualityAction === "output" ? <SpinnerGap size={14} className="spin" /> : <FolderOpen size={14} />} {t("输出目录")}</Button>
            <Button variant="outline"
              type="button"
              size="sm"
              className="h-8 min-w-0 rounded-md px-2 text-xs"
              aria-label={t("打开 PLY")}
              aria-disabled={!artifacts?.scene_ply.validated}
              disabled={qualityAction !== null}
              title={plyActionState(artifacts?.scene_ply).message}
              onClick={() => void openScenePly()}
            >
              {qualityAction === "ply" ? <SpinnerGap size={14} className="spin" /> : <ImageSquare size={14} />} {t("PLY 文件")}</Button>
            <Button variant="outline" size="sm" className="col-span-2 h-8 min-w-0 rounded-md px-2 text-xs" type="button" title={checkpoints.length === 0 ? t("Brush 训练开始后将在这里生成恢复点") : t("查看 {0} 个恢复点", checkpoints.length)} onClick={() => setCheckpointOpen(true)}><Database size={14} />{t("恢复点（{0}）", checkpoints.length)}</Button>
          </div>
        </section>
        <section className="resource-monitor-card rounded-xl bg-muted/50 p-4" aria-labelledby="resource-monitor-heading">
          <div className="task-status-heading"><h3 id="resource-monitor-heading">{t("资源占用")}</h3></div>
          <div className="resource-meter"><span>GPU { `${metrics?.gpu?.utilization_percent?.toFixed(0) ?? "—"}%${metrics?.gpu?.temperature_celsius != null ? ` · ${metrics.gpu.temperature_celsius.toFixed(0)}°C` : ""}`}</span><Progress value={metrics?.gpu?.utilization_percent != null ? gpuPercent : null} aria-label="GPU" /></div>
          <div className="resource-meter"><span>{memory.unified ? t("统一内存") : "VRAM"} { memory.used != null && memory.total != null ? `${(memory.used / 1024 ** 3).toFixed(1)} / ${(memory.total / 1024 ** 3).toFixed(0)} GiB` : t("尚未测量")}</span><Progress value={memory.used != null && memory.total != null ? vramPercent : null} aria-label={memory.unified ? t("统一内存") : "VRAM"} /></div>
          <div className="resource-meter"><span>CPU { cpuPercent != null ? `${cpuPercent.toFixed(0)}%` : t("尚未测量")}</span><Progress value={cpuPercent} aria-label="CPU" /></div>
        </section>
        {artifacts?.latest_checkpoint ? <div className="recent-checkpoint-card"><span>{t("最近恢复点")}</span><strong>{t("{0} 次迭代", artifacts.latest_checkpoint.iteration.toLocaleString(getLocale()))}</strong><small>{new Date(artifacts.latest_checkpoint.created_at).toLocaleString(getLocale())}</small></div> : null}
        <div className="workspace-background-note">{!workspaceComplete && <p>{t("任务可在应用内后台运行。关闭应用前，请先暂停并确认恢复点。")}</p>}<Button variant="ghost" size="sm" className="justify-start rounded-md px-0 text-xs text-muted-foreground" type="button" onClick={() => setActivityOpen(true)}>{t("查看日志与活动")}</Button></div>
        </aside>
  );
}
