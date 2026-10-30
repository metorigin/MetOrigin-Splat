import { Button } from "@/components/ui/button";
import { PipelineStageNavigator } from "@/components/workspace/PipelineStageNavigator";
import { QualityReportDialog } from "@/components/workspace/QualityReportDialog";
import { SceneViewportHost } from "@/components/workspace/SceneViewportHost";
import { TaskInspector } from "@/components/workspace/TaskInspector";
import { useProjectWorkspace } from "@/hooks/useProjectWorkspace";
import type { ReactNode, RefObject } from "react";
import {
  Database,
  Eye,
  Info,
  SpinnerGap,
  X
} from "../components/primitives/icons";
import { localizeMessage, t } from "../i18n";

import { ActionReceipt, AsyncStatus } from "../components";
import { ModalSurface } from "../components/primitives";
import {
  ActivityWorkbench,
  CheckpointDrawer,
  WorkspaceActionDialog
} from "../components/workspace";
import type {
  PipelineStageId,
  ResourceMetrics
} from "../types";

interface ProjectDetailPageProps {
  projectId: string;
  projectPath: string;
  metrics?: ResourceMetrics | null;
  activityOpenSignal?: number;
}


function ResponsiveInspectorSurface({
  open,
  onClose,
  closeRef,
  children,
}: {
  open: boolean;
  onClose: () => void;
  closeRef: RefObject<HTMLElement | null>;
  children: ReactNode;
}) {
  if (!open) return <>{children}</>;
  return (
    <ModalSurface
      id="mobile-project-inspector"
      title={t("预览与质量")}
      titleHidden
      className="mobile-inspector-surface w-[min(400px,calc(100vw-2rem))] overflow-hidden p-4"
      onClose={onClose}
      initialFocusRef={closeRef}
    >
      {children}
    </ModalSurface>
  );
}

export function ProjectDetailPage({ projectId, projectPath, metrics = null, activityOpenSignal = 0 }: ProjectDetailPageProps) {
  const workspace = useProjectWorkspace(projectId, projectPath, metrics, activityOpenSignal);
  const {
    state,
    openCmd,
    project,
    expandedPhase,
    setExpandedPhase,
    selectedStage,
    setSelectedStage,
    stageFocus,
    setStageFocus,
    setPreviewRelativePath,
    setFollowStage,
    artifactResource,
    checkpointResource,
    artifacts,
    checkpoints,
    checkpointOpen,
    setCheckpointOpen,
    inspectorOpen,
    setInspectorOpen,
    activityOpen,
    setActivityOpen,
    setRecoveringStage,
    qualityDialogOpen,
    setQualityDialogOpen,
    qualityAccepting,
    activityRefreshSignal,
    workspaceAction,
    setWorkspaceAction,
    actionReceipt,
    setActionReceipt,
    inspectorCloseRef,
    refreshWorkspaceResources,
    pipelineState,
    currentStage,
    workspaceStatus,
    previewCheckpoint,
    revealCheckpoint,
    moveStageFocus,
    pipelineBusy,
    completeWorkspaceAction,
    acceptQualityRisk,
  } = workspace;
  const selectPreviewStage = (stage: PipelineStageId) => {
    // Selecting the current stage resumes automatic preview updates without
    // needing a separate follow control above the canvas.
    setFollowStage(!workspace.workspaceComplete && stage === workspace.followedStage);
    setPreviewRelativePath(null);
    setSelectedStage(stage);
  };
  if (openCmd.loading && !project) {
    return (
      <div className="workspace-loading">
        <SpinnerGap size={24} className="spin" /> {t("正在加载项目…")}</div>
    );
  }

  if (openCmd.error || !project) {
    return (
      <div className="workspace-empty-state">
        <Info size={28} />
        <h2>{t("无法打开项目")}</h2>
        <p>{localizeMessage(openCmd.error ?? t("项目数据不可用。"))}</p>
      </div>
    );
  }

  return (
    <div className={`project-workspace-grid workspace-state-${workspaceStatus}`}>
      <div className="mobile-workspace-actions">
        <Button variant="outline" type="button" onClick={() => setInspectorOpen(true)}>
          <Eye size={16} /> {t("预览与质量")}</Button>
        <Button variant="outline" type="button" onClick={() => setCheckpointOpen(true)}>
          <Database size={16} /> {t("恢复点（{0}）", checkpoints.length)}
        </Button>
      </div>
      <div className="project-resource-feedback">
        <AsyncStatus
          resource={artifactResource.resource}
          label={t("项目产物")}
          onRetry={() => void refreshWorkspaceResources()}
        />
        <AsyncStatus
          resource={checkpointResource.resource}
          label={t("恢复点")}
          onRetry={() => void refreshWorkspaceResources()}
        />
      </div>
      <PipelineStageNavigator
        pipelineError={state.pipelineError}
        pipelineUpdatedAt={state.pipelineUpdatedAt}
        pipelineState={pipelineState ?? project.pipeline_state}
        expandedPhase={expandedPhase}
        setExpandedPhase={setExpandedPhase}
        currentStage={currentStage}
        stageFocus={stageFocus}
        setStageFocus={setStageFocus}
        selectedStage={selectedStage}
        moveStageFocus={moveStageFocus}
        onSelectStage={selectPreviewStage}
      />

      <div className="inspector-column">
        <div className="scene-viewport-panel flex min-w-0 flex-1 flex-col">
        <SceneViewportHost workspace={workspace} projectId={projectId} projectPath={projectPath} />

        </div>
        <div className="inspector-details-panel min-w-0">
        <ResponsiveInspectorSurface open={inspectorOpen} onClose={() => setInspectorOpen(false)} closeRef={inspectorCloseRef}>
        <TaskInspector workspace={workspace} metrics={metrics} />
        </ResponsiveInspectorSurface>
        </div>
      </div>

      {activityOpen && <ModalSurface id="workspace-activity" title={t("训练日志与活动")} titleHidden className="workspace-activity-drawer h-[min(672px,calc(100dvh-3rem))] w-[min(1152px,calc(100vw-2rem))] gap-0 overflow-hidden p-0" onClose={() => setActivityOpen(false)}>
        <header><div><strong>{t("训练日志与活动")}</strong><span>{t("保留当前项目的真实事件、诊断与错误上下文")}</span></div><Button variant="ghost" size="icon-sm" type="button" onClick={() => setActivityOpen(false)} aria-label={t("关闭日志")}><X size={18} /></Button></header>
        <ActivityWorkbench
          projectPath={projectPath}
          selectedStage={selectedStage}
          onSelectStage={(stageId) => selectPreviewStage(stageId as PipelineStageId)}
          refreshSignal={activityRefreshSignal}
        />
      </ModalSurface>}
      <QualityReportDialog open={qualityDialogOpen} artifacts={artifacts} busy={qualityAccepting} pipelineBusy={pipelineBusy} onClose={() => setQualityDialogOpen(false)} onConfirm={acceptQualityRisk} />
      {checkpointOpen && (
        <CheckpointDrawer
          checkpoints={checkpoints}
          onClose={() => setCheckpointOpen(false)}
          onPreview={(checkpoint) => void previewCheckpoint(checkpoint)}
          onRestore={(checkpoint) => setWorkspaceAction({
            projectId,
            projectPath,
            action: "restore_checkpoint",
            checkpointIteration: checkpoint.iteration,
          })}
          onDelete={(checkpoint) => setWorkspaceAction({
            projectId,
            projectPath,
            action: "delete_checkpoint",
            checkpointIteration: checkpoint.iteration,
          })}
          onOpen={(checkpoint) => void revealCheckpoint(checkpoint)}
        />
      )}
      {workspaceAction && (
        <WorkspaceActionDialog
          request={workspaceAction}
          onClose={() => {
            setWorkspaceAction(null);
            setRecoveringStage(null);
          }}
          onCompleted={completeWorkspaceAction}
        />
      )}
      {actionReceipt ? (
        <ActionReceipt receipt={actionReceipt} onDismiss={() => setActionReceipt(null)} />
      ) : null}
    </div>
  );
}
