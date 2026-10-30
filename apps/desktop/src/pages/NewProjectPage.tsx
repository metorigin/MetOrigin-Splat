import {
  ArrowLeft,
  ArrowRight,
  CheckCircle,
  SpinnerGap
} from "@/components/primitives/icons";
import { localizeMessage, t } from "@/i18n";
import { Fragment } from "react";

import { ErrorNotice, Notification } from "@/components";
import { ModalSurface } from "@/components/primitives/ModalSurface";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import type {
  AppSettings
} from "@/types";



import { ConfirmStep, ImportStep, PreflightStep } from "@/components/new-project/WizardSteps";
import { formatBytes } from "@/components/new-project/wizardPresentation";
import { useNewProjectWizard } from "@/hooks/useNewProjectWizard";

export function NewProjectPage({ settings = null, onOpenSettings }: { settings?: AppSettings | null; onOpenSettings?: () => void }) {
  const {
    STEP_LABELS,
    STEP_PURPOSES,
    step,
    setStep,
    analysis,
    analyzing,
    analyzingKind,
    selectedEstimate,
    imagePreviews,
    previewsLoading,
    previewError,
    chooseSource,
    clearSource,
    selectPreset,
    chooseProjectRoot,
    preflight,
    checking,
    selectedPreset,
    runPreflight,
    projectRoot,
    directoryCheck,
    projectName,
    setProjectName,
    localError,
    creationError,
    cancelOutcome,
    creating,
    copyProgress,
    canceling,
    cancellationRequested,
    requestCancelCreation,
    goNext,
    createProject,
    exitConfirmationOpen,
    setExitConfirmationOpen,
    continueEditingRef,
    closeWizard,
    confirmExit,
  } = useNewProjectWizard(settings);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background text-foreground">
      <section className="mx-auto flex min-h-0 w-full max-w-[960px] flex-1 flex-col" aria-label={t("新建项目向导")}>
        <nav className="mx-6 flex shrink-0 items-center gap-3 border-b border-border py-4 sm:gap-5" aria-label={t("创建步骤")}>
          {STEP_LABELS.map((label, index) => (
            <Fragment key={label}>
              {index > 0 && (
                <span
                  className={cn("h-px min-w-3 max-w-16 flex-1 bg-border", index <= step && "bg-primary")}
                  aria-hidden="true"
                />
              )}
              <div
                className={cn("flex min-w-0 items-center gap-2 text-[13px] text-muted-foreground", index === step && "font-medium text-foreground", index < step && "text-foreground")}
                aria-current={index === step ? "step" : undefined}
              >
                <span className={cn("flex size-6 shrink-0 items-center justify-center rounded-full border border-border text-[11px] tabular-nums", index === step && "border-primary bg-primary text-primary-foreground", index < step && "border-transparent text-primary")}>{index < step ? <CheckCircle size={16} aria-hidden="true" /> : index + 1}</span>
                <span>{label}</span>
                <span className="sr-only">{index < step ? t("已完成") : index === step ? t("当前步骤") : t("下一步")}</span>
              </div>
            </Fragment>
          ))}
        </nav>

        <p className="sr-only">{t("当前目标：")}{STEP_PURPOSES[step]}</p>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
          {step === 0 && (
            <ImportStep
              analysis={analysis}
              analyzing={analyzing}
              analyzingKind={analyzingKind}
              estimate={selectedEstimate}
              imagePreviews={imagePreviews}
              previewsLoading={previewsLoading}
              previewError={previewError}
              onChoose={chooseSource}
              onClear={clearSource}
            />
          )}
          {step === 1 && (
            <PreflightStep
              analysis={analysis}
              preflight={preflight}
              checking={checking}
              selectedPreset={selectedPreset}
              onSelectPreset={selectPreset}
              onRecheck={() => void runPreflight()}
              onOpenSettings={onOpenSettings}
            />
          )}
          {step === 2 && analysis && selectedEstimate && (
            <ConfirmStep
              analysis={analysis}
              estimate={selectedEstimate}
              preflight={preflight}
              directoryCheck={directoryCheck}
              projectName={projectName}
              projectRoot={projectRoot}
              onNameChange={setProjectName}
              onChooseRoot={chooseProjectRoot}
            />
          )}

        {localError && <Notification variant="error" className="mt-4" message={localizeMessage(localError)} />}
        {creationError ? (
          <ErrorNotice
            error={creationError}
            blocking
            onAction={(action) => {
              if (action.kind === "open_settings") onOpenSettings?.();
            }}
          />
        ) : null}
        {cancelOutcome ? <Notification className="mt-4" message={localizeMessage(cancelOutcome)} /> : null}

        {creating && (
          <div className="mt-4 space-y-3 rounded-lg border border-border bg-card p-4 [&>div:first-child]:flex [&>div:first-child]:items-center [&>div:first-child]:gap-2 [&_strong]:flex-1 [&_strong]:text-sm [&_span]:text-xs [&_span]:tabular-nums [&>p]:text-xs [&>p]:text-muted-foreground" aria-live="polite" aria-busy="true">
            <div>
              <SpinnerGap className="animate-spin motion-reduce:animate-none" size={18} />
              <strong>{copyProgress ? t("正在复制素材") : t("正在准备项目目录")}</strong>
              <span>{copyProgress ? `${Math.round(copyProgress.percent * 100)}%` : t("等待首个进度回执")}</span>
            </div>
            {copyProgress ? (
              <Progress
                value={Math.round(copyProgress.percent * 100)}
                aria-label={t("素材复制进度")}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(copyProgress.percent * 100)}
                aria-valuetext={`${formatBytes(copyProgress.copied_bytes)} / ${formatBytes(copyProgress.total_bytes)}`}
              />
            ) : null}
            <p>{copyProgress
              ? `${formatBytes(copyProgress.copied_bytes)} / ${formatBytes(copyProgress.total_bytes)}`
              : t("正在验证保存位置并创建可清理的临时目录。")}</p>
          </div>
        )}

        </div>

        <footer className="mx-6 flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-border bg-background py-3">
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <Button variant="ghost" size="sm" type="button" onClick={() => void closeWizard()} disabled={canceling} aria-label={t("关闭新建项目")}>{t("退出创建")}</Button>
            {step > 0 && <Button variant="outline" type="button" disabled={creating || checking} onClick={() => setStep((current) => current - 1)}><ArrowLeft size={16} />{t("上一步")}</Button>}
            {step === 0 && !analysis?.valid && <span>{t("第 1 / 3 步 · 尚未选择素材")}</span>}
            {step === 1 && preflight && !preflight.can_continue && <span>{t("解决阻断项后才能继续")}</span>}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {creating ? (
              <Button variant="destructive" type="button" disabled={canceling || cancellationRequested.current} onClick={() => void requestCancelCreation()}>
                {canceling || cancellationRequested.current ? t("正在安全取消…") : t("取消复制")}
              </Button>
            ) : step < 2 ? (
              <Button type="button" onClick={() => void goNext()} disabled={step === 0 ? !analysis?.valid || analyzing : !preflight?.can_continue || checking}>
                <span className="sr-only">{t("下一步：")}</span>{checking ? t("正在检查…") : step === 0 ? t("分析素材") : t("继续")}<ArrowRight size={16} />
              </Button>
            ) : (
              <>
                <Button variant={settings?.create_and_start === false ? "default" : "outline"} type="button" onClick={() => void createProject(false)} disabled={!projectName.trim() || checking || !preflight?.can_continue}>{t("仅创建项目")}</Button>
                <Button variant={settings?.create_and_start === false ? "outline" : "default"} type="button" onClick={() => void createProject(true)} disabled={!projectName.trim() || checking || !preflight?.can_continue}>{t("创建并开始重建")}</Button>
              </>
            )}
          </div>
        </footer>
      </section>
      {exitConfirmationOpen && (
        <ModalSurface
          id="wizard-exit-dialog"
          className="w-[min(512px,calc(100vw-2rem))] space-y-4 [&>p]:text-sm [&>p]:leading-relaxed [&>p]:text-muted-foreground"
          role="alertdialog"
          title={creating ? t("取消项目创建？") : t("退出项目创建？")}
          ariaDescribedBy="wizard-exit-description"
          initialFocusRef={continueEditingRef}
          onClose={() => setExitConfirmationOpen(false)}
        >
          <p id="wizard-exit-description">
            {creating
              ? t("素材仍在复制。退出前将安全取消复制并清理未完成的项目目录，原始素材不会被修改。")
              : t("退出后，本次选择的素材、重建预设和项目名称将不会保存，原始素材不会被修改。")}
          </p>
          <div className="flex flex-wrap justify-end gap-2">
            <Button ref={continueEditingRef} variant="outline" type="button" onClick={() => setExitConfirmationOpen(false)}>
              {creating ? t("继续创建") : t("继续编辑")}
            </Button>
            <Button variant="destructive" type="button" onClick={confirmExit}>
              {creating ? t("安全取消并退出") : t("退出并放弃")}
            </Button>
          </div>
        </ModalSurface>
      )}
    </div>
  );
}
