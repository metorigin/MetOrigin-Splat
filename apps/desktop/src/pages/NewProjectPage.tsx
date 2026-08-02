import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle,
  FilmStrip,
  FolderOpen,
  Gauge,
  Images,
  SpinnerGap,
  Warning,
  X,
} from "@phosphor-icons/react";
import { listen } from "@tauri-apps/api/event";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useAppContext } from "../context";
import {
  desktopApi,
  isDesktopRuntime,
  selectImageDirectory,
  selectProjectRoot,
  selectVideoFile,
} from "../services/desktop";
import type {
  AppSettings,
  ImagePreview,
  MediaAnalysis,
  PresetEstimate,
  ProjectCopyProgress,
  ProjectPreflight,
} from "../types";

const STEP_LABELS = ["导入素材", "检查与方案", "确认创建"];

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

export function NewProjectPage({ settings = null }: { settings?: AppSettings | null }) {
  const { dispatch } = useAppContext();
  const [step, setStep] = useState(0);
  const [analysis, setAnalysis] = useState<MediaAnalysis | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzingKind, setAnalyzingKind] = useState<"video" | "images" | null>(null);
  const [imagePreviews, setImagePreviews] = useState<ImagePreview[]>([]);
  const [previewsLoading, setPreviewsLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const sourceRequest = useRef(0);
  const [selectedPreset, setSelectedPreset] = useState(settings?.default_preset ?? "fast");
  const [preflight, setPreflight] = useState<ProjectPreflight | null>(null);
  const [checking, setChecking] = useState(false);
  const [directoryCheck, setDirectoryCheck] = useState<DirectoryCheckState>({ status: "idle" });
  const [projectName, setProjectName] = useState("");
  const [projectRoot, setProjectRoot] = useState<string | null>(settings?.default_project_root ?? null);
  const [creating, setCreating] = useState(false);
  const [copyProgress, setCopyProgress] = useState<ProjectCopyProgress | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    document.getElementById(`wizard-step-heading-${step}`)?.focus();
  }, [step]);

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
    options: { navigateToPreflight?: boolean; announceDirectoryResult?: boolean } = {},
  ) => {
    if (!analysis?.valid) return;
    const { navigateToPreflight = true, announceDirectoryResult = false } = options;
    setChecking(true);
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
        preset: selectedPreset,
      });
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
      setChecking(false);
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
    async (startAfterCreate: boolean) => {
      if (!analysis || !projectName.trim() || checking || !preflight?.can_continue) return;
      setCreating(true);
      setCopyProgress(null);
      setLocalError(null);
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
        setLocalError(String(error));
      } finally {
        setCreating(false);
      }
    },
    [analysis, checking, dispatch, preflight?.can_continue, projectName, projectRoot, selectedPreset],
  );

  const closeWizard = useCallback(() => {
    if (creating) return;
    dispatch({ type: "NAVIGATE", page: { type: "home" } });
  }, [creating, dispatch]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeWizard();
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
          <div>
            <span className="wizard-eyebrow">新建重建项目</span>
            <h1>新建项目</h1>
          </div>
          <button className="icon-button" type="button" onClick={closeWizard} disabled={creating} aria-label="关闭新建项目">
            <X size={18} />
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
                <span>{index < step ? <Check size={14} weight="bold" /> : index + 1}</span>
                <strong>{label}</strong>
              </div>
            </Fragment>
          ))}
        </nav>

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
                setSelectedPreset(preset);
                setPreflight(null);
                setDirectoryCheck({ status: "idle" });
              }}
              onRecheck={() => void runPreflight()}
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

        {creating && (
          <div className="copy-progress-panel" aria-live="polite">
            <div><SpinnerGap className="spin" size={18} /><strong>正在复制素材并创建项目</strong><span>{Math.round((copyProgress?.percent ?? 0) * 100)}%</span></div>
            <div className="progress-track"><span style={{ width: `${(copyProgress?.percent ?? 0) * 100}%` }} /></div>
            <p>{formatBytes(copyProgress?.copied_bytes ?? 0)} / {formatBytes(copyProgress?.total_bytes ?? analysis?.size_bytes ?? 0)}</p>
          </div>
        )}

        <footer className="wizard-footer">
          <div className="wizard-footer-left">
            {step > 0 && <button className="button button-secondary" type="button" disabled={creating || checking} onClick={() => setStep((current) => current - 1)}><ArrowLeft size={16} />上一步</button>}
            {step === 0 && !analysis?.valid && <span>请选择并成功分析素材后继续</span>}
            {step === 1 && preflight && !preflight.can_continue && <span>解决阻断项后才能继续</span>}
          </div>
          <div className="wizard-footer-actions">
            {creating ? (
              <button className="button button-danger" type="button" onClick={() => void desktopApi.cancelProjectCreation()}>取消复制</button>
            ) : step < 2 ? (
              <button className="button button-primary" type="button" onClick={() => void goNext()} disabled={step === 0 ? !analysis?.valid || analyzing : !preflight?.can_continue || checking}>
                {checking ? "正在检查…" : "下一步"}<ArrowRight size={16} />
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
    <section className="wizard-section">
      <div className="wizard-section-heading"><span>1</span><div><h2 id="wizard-step-heading-0" tabIndex={-1}>导入素材</h2><p>选择一段视频，或选择包含连续照片的文件夹。</p></div></div>
      {!analysis ? (
        <div className="source-choice-grid">
          <button type="button" onClick={() => void onChoose("video")} disabled={analyzing}><FilmStrip size={31} /><strong>选择视频</strong><span>MP4、MOV、AVI、MKV</span></button>
          <button type="button" onClick={() => void onChoose("images")} disabled={analyzing}><Images size={31} /><strong>选择图片文件夹</strong><span>JPG、JPEG、PNG</span></button>
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
          {analysis.blockers.map((blocker) => <div className="inline-blocker" key={blocker}><Warning size={16} />{blocker}</div>)}
          {analysis.warnings.map((warning) => <div className="inline-warning" key={warning}><Warning size={16} />{warning}</div>)}
        </div>
      )}
      {analyzing && <div className="analysis-loading"><SpinnerGap className="spin" size={18} />{analyzingKind === "images" ? "正在递归扫描并验证图片…" : "正在调用 FFprobe 读取真实媒体信息…"}</div>}
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

function PreflightStep({ analysis, preflight, checking, selectedPreset, onSelectPreset, onRecheck }: {
  analysis: MediaAnalysis | null;
  preflight: ProjectPreflight | null;
  checking: boolean;
  selectedPreset: string;
  onSelectPreset: (id: string) => void;
  onRecheck: () => void;
}) {
  return (
    <section className="wizard-section">
      <div className="wizard-section-heading"><span>2</span><div><h2 id="wizard-step-heading-1" tabIndex={-1}>检查与方案</h2><p>确认引擎、磁盘空间和本次处理参数。</p></div></div>
      <div className={`preflight-summary ${preflight?.can_continue ? "is-ready" : "is-blocked"}`}>
        {checking ? <SpinnerGap className="spin" size={22} /> : preflight?.can_continue ? <CheckCircle size={22} weight="fill" /> : <Warning size={22} weight="fill" />}
        <div><strong>{checking ? "正在检查" : preflight?.can_continue ? "可以开始" : "暂时不能开始"}</strong><span>{preflight?.can_continue ? "素材、引擎和空间检查均已通过" : "请处理下方阻断项后重新检查"}</span></div>
        <button className="button button-secondary" type="button" onClick={onRecheck} disabled={checking}>重新检查</button>
      </div>
      <div className="preflight-columns">
        <div className="preflight-panel">
          <h3>引擎与训练环境</h3>
          {preflight?.engine_checks.map((engine) => (
            <div className="check-row" key={engine.name} title={engine.path ?? undefined}>
              <span className={engine.available ? "analysis-ok" : "analysis-blocked"}>{engine.available ? <CheckCircle size={16} weight="fill" /> : <Warning size={16} weight="fill" />}</span>
              <div className="engine-check-copy">
                <strong>{engine.name}</strong>
                {engine.diagnostic && <small>{engine.diagnostic}</small>}
              </div>
              <span>{engine.available ? engine.actual_version ?? "已就绪" : "不可用"}</span>
            </div>
          ))}
        </div>
        <div className="preflight-panel"><h3>磁盘空间</h3><Metric label="预计需求（含安全余量）" value={formatBytes(preflight?.estimated_disk_bytes ?? 0)} /><Metric label="目标盘可用" value={formatBytes(preflight?.available_disk_bytes ?? 0)} /></div>
      </div>
      <h3 className="preset-heading">选择质量预设</h3>
      <div className="preset-table">
        {analysis?.preset_estimates.map((preset) => (
          <button type="button" key={preset.id} className={selectedPreset === preset.id ? "is-selected" : ""} onClick={() => onSelectPreset(preset.id)}>
            <span className="preset-radio">{selectedPreset === preset.id && <Check size={13} weight="bold" />}</span>
            <strong>{presetLabel(preset.id)}{preset.id === "fast" && <em>推荐首轮</em>}</strong>
            <span>{preset.fps} fps · 最多 {preset.max_frames} 帧</span>
            <span>最长边 {preset.target_long_edge}px</span>
            <span>Brush {preset.iterations.toLocaleString()} 次</span>
            <b>预计 {preset.estimated_frames} 帧</b>
          </button>
        ))}
      </div>
      {preflight?.blockers.map((blocker) => <div className="inline-blocker" key={blocker}><Warning size={16} />{blocker}</div>)}
      {preflight?.warnings.map((warning) => <div className="inline-warning" key={warning}><Warning size={16} />{warning}</div>)}
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

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="metadata-metric"><span>{label}</span><strong>{value}</strong></div>;
}
