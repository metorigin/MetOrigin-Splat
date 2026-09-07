import {
  ArrowLeft,
  ArrowRight,
  CheckCircle,
  FilmStrip,
  FolderOpen,
  Gauge,
  Images,
  SpinnerGap,
  UploadSimple,
  Warning,
  X,
} from "../components/primitives/icons";
import { listen } from "@tauri-apps/api/event";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ErrorNotice } from "../components";
import { ModalSurface } from "../components/primitives/ModalSurface";
import { selectActivePipelineSnapshot, useAppContext } from "../context";
import { shouldIgnoreShortcut } from "../hooks";
import {
  desktopApi,
  isActivePipelineConflict,
  isDesktopRuntime,
  selectImageDirectory,
  selectProjectRoot,
  selectVideoFile,
} from "../services/desktop";
import { normalizeCommandError } from "../services/errors";
import { isUiPreviewMode } from "../services/uiPreview";
import appIconUrl from "../../src-tauri/icons/app-icon.svg";
import type {
  AppSettings,
  ImagePreview,
  MediaAnalysis,
  PresetEstimate,
  ProjectCopyProgress,
  ProjectPreflight,
  UiError,
} from "../types";

const STEP_LABELS = ["选择素材", "预检与参数", "确认创建"];
const STEP_PURPOSES = [
  "选择要重建的视频或连续照片，并确认素材能够读取。",
  "检查运行环境和磁盘空间，再选择适合本次尝试的质量方案。",
  "确认项目名称、保存位置和复制范围，然后开始创建。",
];

type DirectoryCheckState = {
  status: "idle" | "checking" | "success" | "error";
  message?: string;
};

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "尚未测量";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit >= 3 ? 2 : 1)} ${units[unit]}`;
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "尚未测量";
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds - minutes * 60;
  return minutes > 0
    ? `${minutes} 分 ${remainder.toFixed(1)} 秒`
    : `${remainder.toFixed(1)} 秒`;
}

function presetLabel(id: string): string {
  return { fast: "快速", balanced: "均衡", quality: "高质量" }[id] ?? id;
}

function presetDescription(id: string, fallback: string): string {
  return {
    fast: "使用较低分辨率和较少训练次数，快速验证素材能否完成重建。",
    balanced: "兼顾重建质量与处理时间，适合大多数场景。",
    quality: "使用更高分辨率和更多训练次数，保留更多细节，需要更多显存与磁盘空间。",
  }[id] ?? fallback;
}

export function NewProjectPage({
  settings = null,
  onOpenSettings,
}: {
  settings?: AppSettings | null;
  onOpenSettings?: () => void;
}) {
  const { state, dispatch } = useAppContext();
  const activePipeline = selectActivePipelineSnapshot(state);
  const [step, setStep] = useState(() => {
    if (!isUiPreviewMode()) return 0;
    const requested = Number(new URLSearchParams(window.location.search).get("preview-step") ?? "1");
    return Number.isFinite(requested) ? Math.max(0, Math.min(2, requested - 1)) : 0;
  });
  const [analysis, setAnalysis] = useState<MediaAnalysis | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzingKind, setAnalyzingKind] = useState<"video" | "images" | null>(null);
  const [imagePreviews, setImagePreviews] = useState<ImagePreview[]>([]);
  const [previewsLoading, setPreviewsLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const sourceRequest = useRef(0);
  const [selectedPreset, setSelectedPreset] = useState(settings?.default_preset ?? "fast");
  const [preflight, setPreflight] = useState<ProjectPreflight | null>(null);
  const preflightRequest = useRef(0);
  const [checking, setChecking] = useState(false);
  const [directoryCheck, setDirectoryCheck] = useState<DirectoryCheckState>({ status: "idle" });
  const [projectName, setProjectName] = useState("");
  const [projectRoot, setProjectRoot] = useState<string | null>(settings?.default_project_root ?? null);
  const [creating, setCreating] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const [exitConfirmationOpen, setExitConfirmationOpen] = useState(false);
  const continueEditingRef = useRef<HTMLButtonElement>(null);
  const [copyProgress, setCopyProgress] = useState<ProjectCopyProgress | null>(null);
  const [creationError, setCreationError] = useState<UiError | null>(null);
  const [cancelOutcome, setCancelOutcome] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const createInFlight = useRef<Promise<void> | null>(null);
  const cancelInFlight = useRef<Promise<void> | null>(null);
  const cancellationRequested = useRef(false);
  const exitAfterCancellation = useRef(false);

  useEffect(() => {
    document.getElementById(`wizard-step-heading-${step}`)?.focus();
  }, [step]);

  useEffect(() => {
    if (!isUiPreviewMode() || step === 0 || analysis) return;
    let disposed = false;
    void desktopApi.analyzeMedia("D:\\Captures\\courtyard_walkthrough.mp4").then(async (result) => {
      if (disposed) return;
      setAnalysis(result);
      setProjectName("Courtyard Scan");
      const preset = result.preset_estimates.some((item) => item.id === "balanced")
        ? "balanced"
        : result.preset_estimates[0]?.id ?? "fast";
      setSelectedPreset(preset);
      const checked = await desktopApi.preflightProject({
        sourcePath: result.source_path,
        projectRoot: settings?.default_project_root ?? null,
        preset,
      });
      if (!disposed) setPreflight(checked);
    });
    return () => { disposed = true; };
  }, [analysis, settings?.default_project_root, step]);

  useEffect(() => {
    if (!isDesktopRuntime()) return;
    let unlisten: (() => void) | undefined;
    void listen<ProjectCopyProgress>("project://copy-progress", (event) => {
      setCopyProgress(event.payload);
    }).then((dispose) => {
      unlisten = dispose;
    });
    return () => unlisten?.();
  }, []);

  useEffect(() => () => {
    sourceRequest.current += 1;
    preflightRequest.current += 1;
  }, []);

  const selectedEstimate = useMemo(
    () => analysis?.preset_estimates.find((preset) => preset.id === selectedPreset) ?? null,
    [analysis, selectedPreset],
  );

  useEffect(() => {
    if (!analysis && settings?.default_preset) setSelectedPreset(settings.default_preset);
    if (!projectRoot && settings?.default_project_root) setProjectRoot(settings.default_project_root);
  }, [analysis, projectRoot, settings?.default_preset, settings?.default_project_root]);

  const chooseSource = useCallback(
    async (kind: "video" | "images") => {
      let requestId: number | null = null;
      try {
        const path = kind === "video" ? await selectVideoFile() : await selectImageDirectory();
        if (!path) return;
        requestId = ++sourceRequest.current;
        preflightRequest.current += 1;
        setPreflight(null);
        setChecking(false);
        setLocalError(null);
        setPreviewError(null);
        setImagePreviews([]);
        setPreviewsLoading(false);
        setAnalyzing(true);
        setAnalyzingKind(kind);
        const result = await desktopApi.analyzeMedia(path);
        if (requestId !== sourceRequest.current) return;
        setAnalysis(result);
        setPreflight(null);
        setDirectoryCheck({ status: "idle" });
        const preferredPreset = settings?.default_preset ?? "fast";
        setSelectedPreset(result.preset_estimates.some((preset) => preset.id === preferredPreset)
          ? preferredPreset
          : result.preset_estimates[0]?.id ?? "fast");
        if (!projectName) {
          setProjectName(result.display_name.replace(/\.[^.]+$/, ""));
        }
        if (result.source_kind === "images" && result.valid) {
          setPreviewsLoading(true);
          try {
            const previews = await desktopApi.getImagePreviews(result.source_path);
            if (requestId !== sourceRequest.current) return;
            setImagePreviews(previews);
          } catch (error) {
            if (requestId !== sourceRequest.current) return;
            setPreviewError(`缩略图加载失败：${String(error)}`);
          } finally {
            if (requestId === sourceRequest.current) setPreviewsLoading(false);
          }
        }
      } catch (error) {
        if (requestId === null || requestId === sourceRequest.current) setLocalError(String(error));
      } finally {
        if (requestId !== null && requestId === sourceRequest.current) {
          setAnalyzing(false);
          setAnalyzingKind(null);
        }
      }
    },
    [projectName, settings?.default_preset],
  );

  const runPreflight = useCallback(async (
    targetRoot: string | null = projectRoot,
    options: { navigateToPreflight?: boolean; announceDirectoryResult?: boolean; preset?: string } = {},
  ) => {
    if (!analysis?.valid) return;
    const { navigateToPreflight = true, announceDirectoryResult = false, preset = selectedPreset } = options;
    const requestId = ++preflightRequest.current;
    setChecking(true);
    setPreflight(null);
    setLocalError(null);
    if (announceDirectoryResult) {
      setDirectoryCheck({
        status: "checking",
        message: "正在检查新目录的空间和写入权限…",
      });
    }
    try {
      const result = await desktopApi.preflightProject({
        sourcePath: analysis.source_path,
        projectRoot: targetRoot,
        preset,
      });
      if (requestId !== preflightRequest.current) return;
      setPreflight(result);
      if (announceDirectoryResult) {
        setDirectoryCheck(result.can_continue
          ? {
              status: "success",
              message: `已重新检查，可用空间 ${formatBytes(result.available_disk_bytes)}`,
            }
          : {
              status: "error",
              message: result.blockers.length > 0
                ? "请处理以下问题后重新选择或检查目录。"
                : "新目录未通过项目创建检查，请重新选择目录。",
            });
      }
      if (navigateToPreflight) setStep(1);
    } catch (error) {
      if (requestId !== preflightRequest.current) return;
      setPreflight(null);
      if (announceDirectoryResult) {
        setDirectoryCheck({
          status: "error",
          message: `无法检查新目录：${String(error)}`,
        });
      } else {
        setLocalError(String(error));
      }
    } finally {
      if (requestId === preflightRequest.current) setChecking(false);
    }
  }, [analysis, projectRoot, selectedPreset]);

  const goNext = useCallback(async () => {
    if (step === 0) {
      await runPreflight();
    } else if (step === 1 && preflight?.can_continue) {
      setStep(2);
    }
  }, [preflight?.can_continue, runPreflight, step]);

  const createProject = useCallback(
    (startAfterCreate: boolean) => {
      if (!analysis || !projectName.trim() || checking || !preflight?.can_continue || createInFlight.current) {
        return Promise.resolve();
      }
      setCreating(true);
      setCopyProgress(null);
      setCreationError(null);
      setCancelOutcome(null);
      setLocalError(null);
      cancellationRequested.current = false;
      const operation = (async () => {
      try {
        const result = await desktopApi.createProject({
          name: projectName.trim(),
          sourcePath: analysis.source_path,
          preset: selectedPreset,
          projectRoot,
          startAfterCreate,
        });
        const createdProject = {
          id: result.id,
          name: result.name,
          path: result.path,
          status: result.status,
          updated_at: new Date().toISOString(),
        };
        dispatch({
          type: "ADD_RECENT_PROJECT",
          project: createdProject,
        });
        if (startAfterCreate) {
          if (activePipeline && activePipeline.project_id !== result.id) {
            dispatch({
              type: "SET_PIPELINE_CONFLICT",
              requestedProjectId: result.id,
              activeProjectId: activePipeline.project_id,
            });
            dispatch({
              type: "NAVIGATE",
              page: { type: "project-detail", projectId: result.id, projectPath: result.path },
            });
            dispatch({
              type: "SET_ERROR",
              error: "项目已创建；另一个项目仍在运行，因此本项目未启动，也未进入队列。",
            });
            return;
          }
          try {
            const snapshot = await desktopApi.startPipeline(result.path);
            dispatch({ type: "SET_PIPELINE_SNAPSHOT", snapshot });
            dispatch({
              type: "ADD_RECENT_PROJECT",
              project: {
                ...createdProject,
                status: snapshot.status,
                stage_label: snapshot.state.current_stage ?? undefined,
              },
            });
          } catch (error) {
            if (isActivePipelineConflict(error)) {
              const active = await desktopApi.getActivePipelineSummary().catch(() => null);
              if (active) {
                dispatch({ type: "SET_ACTIVE_PIPELINE", snapshot: active });
                dispatch({
                  type: "SET_PIPELINE_CONFLICT",
                  requestedProjectId: result.id,
                  activeProjectId: active.project_id,
                });
              }
              dispatch({
                type: "NAVIGATE",
                page: { type: "project-detail", projectId: result.id, projectPath: result.path },
              });
              dispatch({
                type: "SET_ERROR",
                error: "项目已创建；活动任务在启动前发生变化，本项目未启动，也未进入队列。",
              });
              return;
            }
            dispatch({
              type: "NAVIGATE",
              page: { type: "project-detail", projectId: result.id, projectPath: result.path },
            });
            dispatch({
              type: "SET_ERROR",
              error: `项目已创建，但未能开始重建：${String(error)}`,
            });
            return;
          }
        }
        dispatch({
          type: "NAVIGATE",
          page: { type: "project-detail", projectId: result.id, projectPath: result.path },
        });
      } catch (error) {
        if (cancellationRequested.current) {
          setCancelOutcome("项目创建已安全取消；未完成目录已清理，原始素材未被修改。");
        } else {
          setCreationError(normalizeCommandError(error, "create_project"));
        }
      } finally {
        setCreating(false);
        setCanceling(false);
        cancellationRequested.current = false;
        createInFlight.current = null;
        if (exitAfterCancellation.current) {
          exitAfterCancellation.current = false;
          dispatch({ type: "NAVIGATE", page: { type: "home" } });
        }
      }
      })();
      createInFlight.current = operation;
      return operation;
    },
    [activePipeline, analysis, checking, dispatch, preflight?.can_continue, projectName, projectRoot, selectedPreset],
  );

  const requestCancelCreation = useCallback(() => {
    if (!creating || cancelInFlight.current) return cancelInFlight.current ?? Promise.resolve();
    cancellationRequested.current = true;
    setCanceling(true);
    setCancelOutcome("正在请求安全取消；已复制内容会在后台确认后清理。");
    const operation = desktopApi.cancelProjectCreation()
      .then(() => {
        setCancelOutcome("已发送安全取消请求，正在等待复制任务停止并清理未完成目录。");
      })
      .catch((error) => {
        cancellationRequested.current = false;
        exitAfterCancellation.current = false;
        setCreationError(normalizeCommandError(error, "cancel_project_creation"));
      })
      .finally(() => {
        setCanceling(false);
        cancelInFlight.current = null;
      });
    cancelInFlight.current = operation;
    return operation;
  }, [creating]);

  const dirty = Boolean(analysis || projectName.trim() || step > 0);
  const closeWizard = useCallback(() => {
    if (canceling || cancellationRequested.current) return;
    if (creating || dirty) {
      setExitConfirmationOpen(true);
      return;
    }
    dispatch({ type: "NAVIGATE", page: { type: "home" } });
  }, [canceling, creating, dirty, dispatch]);

  const confirmExit = () => {
    setExitConfirmationOpen(false);
    if (creating) {
      exitAfterCancellation.current = true;
      void requestCancelCreation();
      return;
    }
    dispatch({ type: "NAVIGATE", page: { type: "home" } });
  };

  useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirty && !creating) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [creating, dirty]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (shouldIgnoreShortcut(event)) return;
      if (event.key === "Escape") {
        event.preventDefault();
        void closeWizard();
      }
      if (event.altKey && event.key === "ArrowLeft" && step > 0 && !creating && !checking) {
        event.preventDefault();
        setStep((current) => current - 1);
      }
      if (event.ctrlKey && event.key === "Enter" && step < 2 && !creating) {
        event.preventDefault();
        void goNext();
      }
      if (event.ctrlKey && event.key === "Enter" && step === 2 && !creating) {
        event.preventDefault();
        void createProject(settings?.create_and_start ?? true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [checking, closeWizard, createProject, creating, goNext, settings?.create_and_start, step]);

  return (
    <div className="wizard-page">
      <section className="project-wizard" aria-label="新建项目向导">
        <header className="wizard-header">
          <button className="wizard-brand" type="button" onClick={() => void closeWizard()} disabled={canceling} title="返回项目中心">
            <img src={appIconUrl} alt="" />
            <span>MetOrigin Splat</span>
          </button>
          <h1>创建新项目</h1>
          <button className="button button-subtle" type="button" onClick={() => void closeWizard()} disabled={canceling} aria-label="关闭新建项目">
            退出创建
          </button>
        </header>

        <nav className="wizard-steps" aria-label="创建步骤">
          {STEP_LABELS.map((label, index) => (
            <Fragment key={label}>
              {index > 0 && (
                <span
                  className={`wizard-connector ${index <= step ? "is-complete" : ""}`}
                  aria-hidden="true"
                />
              )}
              <div
                className={`wizard-step ${index === step ? "is-current" : ""} ${index < step ? "is-complete" : ""}`}
                aria-current={index === step ? "step" : undefined}
              >
                <span className="wizard-step-index">{`0${index + 1}`}</span>
                <span className="wizard-step-copy"><strong>{label}</strong><small>{index < step ? "已完成" : index === step ? "当前步骤" : "下一步"}</small></span>
              </div>
            </Fragment>
          ))}
        </nav>

        <p className="sr-only">当前目标：{STEP_PURPOSES[step]}</p>

        <div className="wizard-body">
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
              onClear={() => {
                sourceRequest.current += 1;
                preflightRequest.current += 1;
                setChecking(false);
                setAnalysis(null);
                setPreflight(null);
                setDirectoryCheck({ status: "idle" });
                setImagePreviews([]);
                setPreviewError(null);
                setPreviewsLoading(false);
              }}
            />
          )}
          {step === 1 && (
            <PreflightStep
              analysis={analysis}
              preflight={preflight}
              checking={checking}
              selectedPreset={selectedPreset}
              onSelectPreset={(preset) => {
                if (preset === selectedPreset) return;
                setSelectedPreset(preset);
                setDirectoryCheck({ status: "idle" });
                void runPreflight(projectRoot, { preset, navigateToPreflight: false });
              }}
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
              onChooseRoot={async () => {
                const root = await selectProjectRoot();
                if (!root) return;
                if (root === projectRoot && directoryCheck.status !== "error") return;
                setProjectRoot(root);
                setPreflight(null);
                await runPreflight(root, {
                  navigateToPreflight: false,
                  announceDirectoryResult: true,
                });
              }}
            />
          )}
        </div>

        {localError && <div className="wizard-error" role="alert"><Warning size={17} weight="fill" />{localError}</div>}
        {creationError ? (
          <ErrorNotice
            error={creationError}
            blocking
            onAction={(action) => {
              if (action.kind === "open_settings") onOpenSettings?.();
            }}
          />
        ) : null}
        {cancelOutcome ? <div className="wizard-cancel-outcome" role="status">{cancelOutcome}</div> : null}

        {creating && (
          <div className="copy-progress-panel" aria-live="polite" aria-busy="true">
            <div>
              <SpinnerGap className="spin" size={18} />
              <strong>{copyProgress ? "正在复制素材" : "正在准备项目目录"}</strong>
              <span>{copyProgress ? `${Math.round(copyProgress.percent * 100)}%` : "等待首个进度回执"}</span>
            </div>
            {copyProgress ? (
              <div
                className="progress-track"
                role="progressbar"
                aria-label="素材复制进度"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(copyProgress.percent * 100)}
                aria-valuetext={`${formatBytes(copyProgress.copied_bytes)} / ${formatBytes(copyProgress.total_bytes)}`}
              >
                <span style={{ width: `${copyProgress.percent * 100}%` }} />
              </div>
            ) : null}
            <p>{copyProgress
              ? `${formatBytes(copyProgress.copied_bytes)} / ${formatBytes(copyProgress.total_bytes)}`
              : "正在验证保存位置并创建可清理的临时目录。"}</p>
          </div>
        )}

        <footer className="wizard-footer">
          <div className="wizard-footer-left">
            {step > 0 && <button className="button button-secondary" type="button" disabled={creating || checking} onClick={() => setStep((current) => current - 1)}><ArrowLeft size={16} />上一步</button>}
            {step === 0 && !analysis?.valid && <span>第 1 / 3 步 · 尚未选择素材</span>}
            {step === 1 && preflight && !preflight.can_continue && <span>解决阻断项后才能继续</span>}
          </div>
          <div className="wizard-footer-actions">
            {creating ? (
              <button className="button button-danger" type="button" disabled={canceling || cancellationRequested.current} onClick={() => void requestCancelCreation()}>
                {canceling || cancellationRequested.current ? "正在安全取消…" : "取消复制"}
              </button>
            ) : step < 2 ? (
              <button className="button button-primary" type="button" onClick={() => void goNext()} disabled={step === 0 ? !analysis?.valid || analyzing : !preflight?.can_continue || checking}>
                <span className="sr-only">下一步：</span>{checking ? "正在检查…" : step === 0 ? "分析素材" : "继续"}<ArrowRight size={16} />
              </button>
            ) : (
              <>
                <button className={`button ${settings?.create_and_start === false ? "button-primary" : "button-secondary"}`} type="button" onClick={() => void createProject(false)} disabled={!projectName.trim() || checking || !preflight?.can_continue}>仅创建项目</button>
                <button className={`button ${settings?.create_and_start === false ? "button-secondary" : "button-primary"}`} type="button" onClick={() => void createProject(true)} disabled={!projectName.trim() || checking || !preflight?.can_continue}>创建并开始重建</button>
              </>
            )}
          </div>
        </footer>
      </section>
      {exitConfirmationOpen && (
        <ModalSurface
          id="wizard-exit-dialog"
          className="wizard-exit-dialog"
          role="alertdialog"
          title={creating ? "取消项目创建？" : "退出项目创建？"}
          ariaDescribedBy="wizard-exit-description"
          initialFocusRef={continueEditingRef}
          onClose={() => setExitConfirmationOpen(false)}
        >
          <p id="wizard-exit-description">
            {creating
              ? "素材仍在复制。退出前将安全取消复制并清理未完成的项目目录，原始素材不会被修改。"
              : "退出后，本次选择的素材、重建预设和项目名称将不会保存，原始素材不会被修改。"}
          </p>
          <div className="dialog-actions">
            <button ref={continueEditingRef} className="button button-secondary" type="button" onClick={() => setExitConfirmationOpen(false)}>
              {creating ? "继续创建" : "继续编辑"}
            </button>
            <button className="button button-danger" type="button" onClick={confirmExit}>
              {creating ? "安全取消并退出" : "退出并放弃"}
            </button>
          </div>
        </ModalSurface>
      )}
    </div>
  );
}

function ImportStep({ analysis, analyzing, analyzingKind, estimate, imagePreviews, previewsLoading, previewError, onChoose, onClear }: {
  analysis: MediaAnalysis | null;
  analyzing: boolean;
  analyzingKind: "video" | "images" | null;
  estimate: PresetEstimate | null;
  imagePreviews: ImagePreview[];
  previewsLoading: boolean;
  previewError: string | null;
  onChoose: (kind: "video" | "images") => Promise<void>;
  onClear: () => void;
}) {
  return (
    <section className="wizard-section import-step">
      <div className="wizard-section-heading"><div><h2 id="wizard-step-heading-0" tabIndex={-1}>选择重建素材</h2><p>导入一段连续视频或一组围绕目标拍摄的照片。</p></div></div>
      <div className="import-primary-panel">
      {!analysis ? (
        <div className="source-drop-zone">
          <span className="source-upload-icon" aria-hidden="true"><UploadSimple size={31} /></span>
          <strong>拖放素材到这里</strong>
          <span>支持 MP4、MOV 或 JPG、PNG 图片文件夹<br />建议 80–500 张图像，单次导入不超过 20 GB</span>
          <div className="source-choice-grid">
            <button type="button" onClick={() => void onChoose("video")} disabled={analyzing}><FilmStrip size={19} /><strong>选择视频</strong><span>MP4、MOV、AVI、MKV</span></button>
            <button type="button" onClick={() => void onChoose("images")} disabled={analyzing} aria-describedby="image-folder-selection-hint"><Images size={19} /><strong>选择图片文件夹</strong><span>浏览 JPG、JPEG、PNG 图片</span></button>
          </div>
          <p id="image-folder-selection-hint" className="source-selection-hint">选择任意一张图片，即可导入其所在文件夹及子文件夹中的全部有效图片。</p>
        </div>
      ) : (
        <div className="media-analysis-card">
          <div className="media-analysis-title">
            <span className={analysis.valid ? "analysis-ok" : "analysis-blocked"}>{analysis.valid ? <CheckCircle size={24} weight="fill" /> : <Warning size={24} weight="fill" />}</span>
            <div><strong>{analysis.display_name}</strong><span>{analysis.source_path}</span></div>
            <button className="button button-secondary" type="button" onClick={() => void onChoose(analysis.source_kind)}>替换素材</button>
            <button className="icon-button" type="button" onClick={onClear} aria-label="清除素材"><X size={17} /></button>
          </div>
          {analysis.video_metadata ? (
            <div className="metadata-grid">
              <Metric label="分辨率" value={`${analysis.video_metadata.width} × ${analysis.video_metadata.height}`} />
              <Metric label="帧率" value={`${analysis.video_metadata.fps.toFixed(2)} fps`} />
              <Metric label="时长" value={formatDuration(analysis.video_metadata.duration_seconds)} />
              <Metric label="编码" value={analysis.video_metadata.codec.toUpperCase()} />
              <Metric label="源帧数" value={analysis.video_metadata.frame_count ? analysis.video_metadata.frame_count.toLocaleString() : "尚未测量"} />
              <Metric label="文件大小" value={formatBytes(analysis.size_bytes)} />
            </div>
          ) : analysis.image_set_metadata ? (
            <div className="metadata-grid">
              <Metric label="有效图片" value={`${analysis.image_set_metadata.image_count} 张`} />
              <Metric label="实际使用" value={`${estimate?.estimated_frames ?? analysis.image_set_metadata.image_count} 张`} />
              <Metric label="目标最长边" value={`${estimate?.target_long_edge ?? 0}px（只缩小）`} />
              <Metric label="忽略文件" value={`${analysis.image_set_metadata.ignored_count} 个`} />
              <Metric label="损坏图片" value={`${analysis.image_set_metadata.invalid_count} 张`} />
              <Metric label="总大小" value={formatBytes(analysis.image_set_metadata.total_size_bytes)} />
              <Metric label="格式" value={Object.entries(analysis.image_set_metadata.formats).map(([format, count]) => `${format.toUpperCase()} ${count}`).join(" / ")} />
            </div>
          ) : null}
          {analysis.source_kind === "images" && (
            <div className="image-preview-section" aria-live="polite">
              <div className="image-preview-heading"><strong>图片预览</strong><span>从完整排序中均匀选取，预览不会读取目录外文件</span></div>
              {previewsLoading ? (
                <div className="image-preview-status"><SpinnerGap className="spin" size={17} />正在生成安全缩略图…</div>
              ) : previewError ? (
                <div className="image-preview-status is-error" role="alert"><Warning size={17} />{previewError}</div>
              ) : imagePreviews.length > 0 ? (
                <div className="image-preview-grid">
                  {imagePreviews.map((preview) => <ImagePreviewTile key={preview.relative_path} preview={preview} />)}
                </div>
              ) : (
                <div className="image-preview-status">没有可显示的缩略图。</div>
              )}
            </div>
          )}
          {analysis.preset_estimates.length > 0 && (
            <div className="estimate-strip">
              {analysis.preset_estimates.map((preset) => <span key={preset.id}><strong>{presetLabel(preset.id)}</strong>预计 {preset.estimated_frames} 帧</span>)}
            </div>
          )}
          {analysis.warnings.length > 0 ? (
            <section className="wizard-message-group is-warning" aria-label="可以继续的提醒">
              <h3>可以继续的提醒</h3>
              {analysis.warnings.map((warning) => <div className="inline-warning" key={warning}><Warning size={16} />{warning}</div>)}
            </section>
          ) : null}
          {analysis.blockers.length > 0 ? (
            <section className="wizard-message-group is-blocking" aria-label="需要处理的问题">
              <h3>需要处理后才能继续</h3>
              {analysis.blockers.map((blocker) => <div className="inline-blocker" key={blocker}><Warning size={16} />{blocker}<span>请重新选择可读取的素材后再次分析。</span></div>)}
            </section>
          ) : null}
        </div>
      )}
      {analyzing && <div className="analysis-loading"><SpinnerGap className="spin" size={18} />{analyzingKind === "images" ? "正在递归扫描并验证图片…" : "正在调用 FFprobe 读取真实媒体信息…"}</div>}
      </div>
      <aside className="capture-tips-panel" aria-label="拍摄与素材提示">
        <h2>提高重建质量</h2>
        <ol>
          <li>保持 70% 以上画面重叠</li>
          <li>围绕静止主体缓慢移动，避免跳跃</li>
          <li>锁定曝光并减少动态物体</li>
          <li>补拍顶部、背面和遮挡区域</li>
        </ol>
        <p className="capture-report-note"><CheckCircle size={17} weight="fill" />导入后检查素材与运行环境</p>
        <p className="local-processing-note">素材默认仅在本机处理<br />除非你主动导出，否则不会上传。</p>
      </aside>
    </section>
  );
}

function ImagePreviewTile({ preview }: { preview: ImagePreview }) {
  const [failed, setFailed] = useState(!preview.data_url);
  return (
    <figure className="image-preview-tile">
      <div>{failed ? <span><Warning size={18} />无法解码</span> : <img src={preview.data_url} alt={preview.display_name} onError={() => setFailed(true)} />}</div>
      <figcaption><strong title={preview.relative_path}>{preview.display_name}</strong><span>{preview.width} × {preview.height}</span></figcaption>
    </figure>
  );
}

function PreflightStep({ analysis, preflight, checking, selectedPreset, onSelectPreset, onRecheck, onOpenSettings }: {
  analysis: MediaAnalysis | null;
  preflight: ProjectPreflight | null;
  checking: boolean;
  selectedPreset: string;
  onSelectPreset: (id: string) => void;
  onRecheck: () => void;
  onOpenSettings?: () => void;
}) {
  const selectedEstimate = analysis?.preset_estimates.find((preset) => preset.id === selectedPreset);
  const effectiveFrameCount = selectedEstimate?.estimated_frames ?? preflight?.estimated_frames;
  const resolution = analysis?.video_metadata ? `${analysis.video_metadata.width} × ${analysis.video_metadata.height}` : "原始分辨率";
  const warnings = [...new Set([...(analysis?.warnings ?? []), ...(preflight?.warnings ?? [])])];
  return (
    <section className="wizard-section preflight-step">
      <div className="preflight-results-panel">
        <header className="preflight-results-heading">
          <div><h2 id="wizard-step-heading-1" tabIndex={-1}>素材分析结果</h2><p>{analysis?.display_name ?? "等待素材分析"}</p></div>
          <span className={`status-pill ${preflight?.can_continue ? "status-completed" : "status-failed"}`}><i />{checking ? "检查中" : preflight?.can_continue ? "已完成" : "需处理"}</span>
        </header>
        <div className="analysis-metrics">
          <Metric label="预计处理帧数" value={effectiveFrameCount?.toLocaleString() ?? "—"} detail="根据素材与所选预设估算" />
          <Metric label="源分辨率" value={resolution} detail="保留原始长宽比" />
          <Metric label="训练迭代" value={selectedEstimate?.iterations.toLocaleString() ?? "—"} detail="预设目标次数" />
        </div>
        <h3 className="preflight-checks-heading">预检结果</h3>
        {checking && <p className="preflight-progress-note" role="status"><SpinnerGap className="spin" size={16} />正在按当前预设检查磁盘空间与运行环境…</p>}
        <div className="visual-check-list">
          <div><span><strong>素材可用性</strong><small>{analysis?.valid ? "素材格式与读取检查通过" : "等待素材检查"}</small></span><span className="status-pill"><i />{analysis?.valid ? "通过" : "待检查"}</span></div>
          {(preflight?.engine_checks ?? []).map((engine) => <div key={engine.name}><span><strong>{engine.name}</strong>{engine.actual_version ? <small>{engine.actual_version}</small> : null}<small>{engine.diagnostic ?? (engine.available ? "组件检查通过" : "未通过组件检查")}</small></span><span className={`status-pill ${engine.available ? "status-completed" : "status-failed"}`}><i />{engine.available ? "就绪" : "不可用"}</span></div>)}
        </div>
        {warnings.map((warning) => <div className="inline-warning" key={warning}><Warning size={16} /><span>{warning}</span></div>)}
        {preflight?.blockers.length ? (
          <section className="wizard-message-group is-blocking" aria-label="需要处理的问题">
            <h3>需要处理后才能继续</h3>
            {preflight.blockers.map((blocker) => <div className="inline-blocker" key={blocker}><Warning size={16} /><span>{blocker}<small>修复相关组件、显卡环境或保存位置后重新检查。</small></span></div>)}
            <div className="wizard-repair-actions">
              {onOpenSettings ? <button type="button" className="button button-secondary" onClick={onOpenSettings}>打开设置</button> : null}
            </div>
          </section>
        ) : null}
      </div>
      <aside className="preset-panel">
        <div><h2>重建预设</h2><p>选择处理帧数、分辨率与训练迭代次数。</p></div>
        <div className="preset-table">
          {analysis?.preset_estimates.map((preset) => (
            <button type="button" key={preset.id} className={selectedPreset === preset.id ? "is-selected" : ""} onClick={() => onSelectPreset(preset.id)}>
              <span><strong>{presetLabel(preset.id)}{preset.id === "balanced" && <em>推荐</em>}</strong><small>{selectedPreset === preset.id ? "已选择" : "选择"}</small></span>
              <span>{preset.estimated_frames} 帧 · {preset.iterations.toLocaleString()} 次迭代 · 约 {formatBytes(preset.estimated_disk_bytes)}</span>
              <span>{presetDescription(preset.id, preset.description)}</span>
            </button>
          ))}
        </div>
        <details className="advanced-parameter-details">
          <summary className="advanced-parameter-row">参数详情 <span>当前预设</span></summary>
          {selectedEstimate ? <div className="preflight-engine-summary"><div>训练最长边：{selectedEstimate.target_long_edge} px</div><div>相机重建最长边：{selectedEstimate.colmap_long_edge} px</div><div>检查点间隔：{selectedEstimate.checkpoint_interval} 次迭代</div><div>球谐阶数：{selectedEstimate.sh_degree}</div></div> : null}
        </details>
        <p className="preset-capacity-note">磁盘用量为预估值。训练耗时与显存占用以实际运行数据为准。</p>
        <button type="button" className="button button-secondary preflight-recheck" onClick={onRecheck} disabled={checking}>{checking ? "检查中…" : "重新检查"}</button>
      </aside>
    </section>
  );
}

function ConfirmStep({ analysis, estimate, preflight, directoryCheck, projectName, projectRoot, onNameChange, onChooseRoot }: {
  analysis: MediaAnalysis;
  estimate: PresetEstimate;
  preflight: ProjectPreflight | null;
  directoryCheck: DirectoryCheckState;
  projectName: string;
  projectRoot: string | null;
  onNameChange: (value: string) => void;
  onChooseRoot: () => Promise<void>;
}) {
  return (
    <section className="wizard-section">
      <div className="wizard-section-heading"><span>3</span><div><h2 id="wizard-step-heading-2" tabIndex={-1}>确认创建</h2><p>素材将复制到项目目录，原始文件不会被修改。</p></div></div>
      <div className="confirm-form">
        <label><span>项目名称</span><input value={projectName} maxLength={80} onChange={(event) => onNameChange(event.target.value)} placeholder="例如：自行车街景测试" autoFocus /></label>
        <div className="confirm-field">
          <span className="confirm-field-label" id="project-root-label">项目保存位置</span>
          <div className="path-picker" aria-labelledby="project-root-label">
            <span>{projectRoot ?? "文档 / MetOrigin Projects（默认）"}</span>
            <button className="button button-secondary" type="button" onClick={() => void onChooseRoot()} disabled={directoryCheck.status === "checking"}><FolderOpen size={16} />更改目录</button>
          </div>
          {directoryCheck.status !== "idle" && (
            <div
              className={`directory-check is-${directoryCheck.status}`}
              role={directoryCheck.status === "error" ? "alert" : "status"}
              aria-live={directoryCheck.status === "error" ? "assertive" : "polite"}
            >
              {directoryCheck.status === "checking" && <SpinnerGap className="spin" size={18} />}
              {directoryCheck.status === "success" && <CheckCircle size={18} weight="fill" />}
              {directoryCheck.status === "error" && <Warning size={18} weight="fill" />}
              <div>
                <strong>{directoryCheck.status === "checking" ? "正在检查新目录" : directoryCheck.status === "success" ? "新目录可用" : "新目录不可用"}</strong>
                {directoryCheck.message && <span>{directoryCheck.message}</span>}
              </div>
              {directoryCheck.status === "error" && (
                <button className="button button-secondary" type="button" onClick={() => void onChooseRoot()}>重新选择目录</button>
              )}
            </div>
          )}
          {directoryCheck.status === "error" && preflight?.blockers.map((blocker) => (
            <div className="directory-check-blocker" key={blocker}><Warning size={15} />{blocker}</div>
          ))}
        </div>
      </div>
      <div className="creation-summary">
        <div><FilmStrip size={19} /><span>素材</span><strong>{analysis.display_name}</strong></div>
        <div><Gauge size={19} /><span>质量方案</span><strong>{presetLabel(estimate.id)} · {estimate.estimated_frames} 帧 · {estimate.iterations.toLocaleString()} 次训练</strong></div>
        <div><FolderOpen size={19} /><span>复制方式</span><strong>复制到项目（{formatBytes(analysis.size_bytes)}）</strong></div>
      </div>
    </section>
  );
}

function Metric({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return <div className="metadata-metric"><span>{label}</span><strong>{value}</strong>{detail ? <small>{detail}</small> : null}</div>;
}
