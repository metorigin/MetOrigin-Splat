import { t } from "@/i18n";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { selectActivePipelineSnapshot, useAppContext } from "@/context";
import { shouldIgnoreShortcut } from "@/hooks";
import { hasPrimaryModifier } from "@/lib/platformShortcuts";
import {
  desktopApi,
  isActivePipelineConflict,
  isDesktopRuntime,
  selectImageDirectory,
  selectProjectRoot,
  selectVideoFile
} from "@/services/desktop";
import { normalizeCommandError } from "@/services/errors";
import { isUiPreviewMode } from "@/services/uiPreview";
import type {
  AppSettings,
  ImagePreview,
  MediaAnalysis,
  ProjectCopyProgress,
  ProjectPreflight,
  UiError
} from "@/types";



import type { DirectoryCheckState } from "@/components/new-project/wizardPresentation";
import { formatBytes } from "@/components/new-project/wizardPresentation";

export function useNewProjectWizard(settings: AppSettings | null) {
  const STEP_LABELS = [t("选择素材"), t("预检与参数"), t("确认创建")];
  const STEP_PURPOSES = [
    t("选择要重建的视频或连续照片，并确认素材能够读取。"),
    t("检查运行环境和磁盘空间，再选择适合本次尝试的质量方案。"),
    t("确认项目名称、保存位置和复制范围，然后开始创建。"),
  ];
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
            setPreviewError(t("缩略图加载失败：{0}", String(error)));
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
        message: t("正在检查新目录的空间和写入权限…"),
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
              message: t("已重新检查，可用空间 {0}", formatBytes(result.available_disk_bytes)),
            }
          : {
              status: "error",
              message: result.blockers.length > 0
                ? t("请处理以下问题后重新选择或检查目录。")
                : t("新目录未通过项目创建检查，请重新选择目录。"),
            });
      }
      if (navigateToPreflight) setStep(1);
    } catch (error) {
      if (requestId !== preflightRequest.current) return;
      setPreflight(null);
      if (announceDirectoryResult) {
        setDirectoryCheck({
          status: "error",
          message: t("无法检查新目录：{0}", String(error)),
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
              error: t("项目已创建；另一个项目仍在运行，因此本项目未启动，也未进入队列。"),
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
                error: t("项目已创建；活动任务在启动前发生变化，本项目未启动，也未进入队列。"),
              });
              return;
            }
            dispatch({
              type: "NAVIGATE",
              page: { type: "project-detail", projectId: result.id, projectPath: result.path },
            });
            dispatch({
              type: "SET_ERROR",
              error: t("项目已创建，但未能开始重建：{0}", String(error)),
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
          setCancelOutcome(t("项目创建已安全取消；未完成目录已清理，原始素材未被修改。"));
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
    setCancelOutcome(t("正在请求安全取消；已复制内容会在后台确认后清理。"));
    const operation = desktopApi.cancelProjectCreation()
      .then(() => {
        setCancelOutcome(t("已发送安全取消请求，正在等待复制任务停止并清理未完成目录。"));
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
      if (hasPrimaryModifier(event) && event.key === "Enter" && step < 2 && !creating) {
        event.preventDefault();
        void goNext();
      }
      if (hasPrimaryModifier(event) && event.key === "Enter" && step === 2 && !creating) {
        event.preventDefault();
        void createProject(settings?.create_and_start ?? true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [checking, closeWizard, createProject, creating, goNext, settings?.create_and_start, step]);

  const clearSource = () => {
    sourceRequest.current += 1;
    preflightRequest.current += 1;
    setChecking(false);
    setAnalysis(null);
    setPreflight(null);
    setDirectoryCheck({ status: "idle" });
    setImagePreviews([]);
    setPreviewError(null);
    setPreviewsLoading(false);
  };
  const selectPreset = (preset: string) => {
    if (preset === selectedPreset) return;
    setSelectedPreset(preset);
    setDirectoryCheck({ status: "idle" });
    void runPreflight(projectRoot, { preset, navigateToPreflight: false });
  };
  const chooseProjectRoot = async () => {
    const root = await selectProjectRoot();
    if (!root || (root === projectRoot && directoryCheck.status !== "error")) return;
    setProjectRoot(root);
    setPreflight(null);
    await runPreflight(root, { navigateToPreflight: false, announceDirectoryResult: true });
  };
  return {
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
  };
}
