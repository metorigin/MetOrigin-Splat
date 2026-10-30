import { CaretDown, Check, PauseCircle, SpinnerGap, StopCircle, Warning, XCircle } from "@/components/primitives/icons";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { getLocale, localizeMessage, t } from "@/i18n";
import { getStageLabel } from "@/localization";
import { phaseProgressPercent, PHASES, phaseStatus, phaseStatusLabel, stageStatusLabel } from "@/pages/projectTimeline";
import type { PipelineStageId, PipelineState } from "@/types";
import type { Dispatch, KeyboardEvent, SetStateAction } from "react";

interface Props {
  pipelineError: string | null;
  pipelineUpdatedAt: number | null;
  pipelineState: PipelineState;
  expandedPhase: string | null;
  setExpandedPhase: Dispatch<SetStateAction<string | null>>;
  currentStage: string | null;
  stageFocus: PipelineStageId | null;
  setStageFocus: Dispatch<SetStateAction<PipelineStageId | null>>;
  selectedStage: PipelineStageId | null;
  moveStageFocus: (event: KeyboardEvent<HTMLButtonElement>, stages: readonly PipelineStageId[], stage: PipelineStageId) => void;
  onSelectStage: (stage: PipelineStageId) => void;
}

/** Presentation only: stage selection controls the preview; recovery stays in the task inspector. */
export function PipelineStageNavigator({ pipelineError, pipelineUpdatedAt, pipelineState, expandedPhase, setExpandedPhase, currentStage, stageFocus, setStageFocus, selectedStage, moveStageFocus, onSelectStage }: Props) {
  return (
      <section className="timeline-panel" tabIndex={-1}>
        {pipelineError && (
          <div className="pipeline-stale-warning" role="status">
            <Warning size={16} weight="fill" />
            <span>{t("Pipeline 状态更新失败，正在显示最后一次成功获取的数据")}{pipelineUpdatedAt ? `（${new Date(pipelineUpdatedAt).toLocaleTimeString(getLocale(), { hour12: false })}）` : ""}。</span>
          </div>
        )}
        <div className="panel-heading-row">
          <span>{t("里程碑 / 阶段")}</span>
          <span>{t("状态 / 进度")}</span>
        </div>
        <div className="pipeline-timeline">
          {PHASES.map((phase, index) => {
            const status = phaseStatus(pipelineState, phase);
            const expanded = expandedPhase === phase.id;
            const phaseProgress = phaseProgressPercent(pipelineState, phase);
            const previewSelected = selectedStage !== null && phase.stages.includes(selectedStage);
            const showStatus = status !== "completed" && status !== "pending";
            return (
              <Collapsible
                className={`timeline-phase status-${status}${previewSelected ? " is-preview-phase" : ""}`}
                key={phase.id}
                open={expanded}
                onOpenChange={(open) => {
                  setExpandedPhase(open ? phase.id : null);
                  if (open) setStageFocus(currentStage && phase.stages.includes(currentStage as PipelineStageId) ? currentStage as PipelineStageId : phase.stages[0]);
                }}
              >
                <CollapsibleTrigger asChild>
                <Button variant="ghost"
                  id={`phase-summary-${phase.id}`}
                  type="button"
                  className="phase-summary grid h-11 w-full gap-x-2 rounded-md px-3 py-2 text-left"
                  aria-label={`${index + 1}. ${[t("素材准备"), t("相机重建"), t("模型训练"), t("结果导出")][index]} · ${phase.label} · ${phaseStatusLabel(status)} · ${phaseProgress}%`}
                  aria-expanded={expanded}
                  aria-controls={`phase-stage-list-${phase.id}`}
                  title={`${phase.description} · ${phaseStatusLabel(status)} · ${phaseProgress}%`}
                >
                  <span className="phase-index-icon" aria-hidden="true">
                    {status === "completed" ? (
                      <Check size={16} weight="bold" />
                    ) : ["running", "pausing", "cancelling"].includes(status) ? (
                      <SpinnerGap size={17} className="spin" />
                    ) : status === "failed" ? (
                      <XCircle size={17} weight="fill" />
                    ) : status === "paused" ? (
                      <PauseCircle size={17} weight="fill" />
                    ) : status === "cancelled" ? (
                      <StopCircle size={17} />
                    ) : (
                      index + 1
                    )}
                  </span>
                  <span className="phase-copy">
                    <strong>{phase.label}</strong>
                    <span>{phase.description}</span>
                  </span>
                  {showStatus ? <span className="phase-status-copy" aria-hidden="true">
                    {status === "running" && phaseProgress > 0 ? `${phaseProgress}%` : phaseStatusLabel(status)}
                  </span> : null}

                  <CaretDown size={13} className="phase-chevron" aria-hidden="true" />
                </Button>
                </CollapsibleTrigger>
                <CollapsibleContent asChild>
                  <div id={`phase-stage-list-${phase.id}`} className="stage-list" role="list" aria-labelledby={`phase-summary-${phase.id}`}>
                    {phase.stages.map((stage) => {
                      const stageState = pipelineState.stages[stage];
                      const stageStatus = stageState?.status ?? "pending";
                      return (
                        <div role="listitem" className={`stage-list-item ${selectedStage === stage ? "is-selected" : ""}`} key={stage}>
                          <Button variant="ghost"
                            id={`stage-button-${stage}`}
                            type="button"
                            tabIndex={stageFocus === stage || (!stageFocus && phase.stages[0] === stage) ? 0 : -1}
                            aria-current={currentStage === stage ? "step" : undefined}
                            aria-pressed={selectedStage === stage}
                            className={`stage-list-row flex h-auto w-full justify-start gap-2 px-2 py-2 text-left text-xs ${selectedStage === stage ? "is-selected" : ""}`}
                            onFocus={() => setStageFocus(stage)}
                            onKeyDown={(event) => moveStageFocus(event, phase.stages, stage)}
                            onClick={() => onSelectStage(stage)}
                          >
                            <span className={`stage-dot status-${stageStatus}`} aria-hidden="true" />
                            <span>{getStageLabel(stage)}</span>
                            <span className="stage-list-progress">
                              {stageStatusLabel(stageStatus, stageState?.progress ?? 0)}
                            </span>
                          </Button>
                          {selectedStage === stage && stageState?.error ? <p className="stage-inline-error" role="alert">{localizeMessage(stageState.error)}</p> : null}
                        </div>
                      );
                    })}
                  </div>
                </CollapsibleContent>
              </Collapsible>
            );
          })}
        </div>
      </section>

  );
}
