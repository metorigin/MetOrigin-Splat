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
import { useCallback, useEffect, useMemo, useState } from "react";

import { useAppContext } from "../context";
import {
  desktopApi,
  selectImageDirectory,
  selectProjectRoot,
  selectVideoFile,
} from "../services/desktop";
import type {
  AppSettings,
  MediaAnalysis,
  PresetEstimate,
  ProjectCopyProgress,
  ProjectPreflight,
} from "../types";

const STEP_LABELS = ["导入素材", "检查与方案", "确认创建"];

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
  const [selectedPreset, setSelectedPreset] = useState(settings?.default_preset ?? "fast");
  const [preflight, setPreflight] = useState<ProjectPreflight | null>(null);
  const [checking, setChecking] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [projectRoot, setProjectRoot] = useState<string | null>(settings?.default_project_root ?? null);
  const [creating, setCreating] = useState(false);
  const [copyProgress, setCopyProgress] = useState<ProjectCopyProgress | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<ProjectCopyProgress>("project://copy-progress", (event) => {
      setCopyProgress(event.payload);
    }).then((dispose) => {
      unlisten = dispose;
    });
    return () => unlisten?.();
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
      setLocalError(null);
      try {
        const path = kind === "video" ? await selectVideoFile() : await selectImageDirectory();
        if (!path) return;
        setAnalyzing(true);
        const result = await desktopApi.analyzeMedia(path);
        setAnalysis(result);
        setPreflight(null);
        const preferredPreset = settings?.default_preset ?? "fast";
        setSelectedPreset(result.preset_estimates.some((preset) => preset.id === preferredPreset)
          ? preferredPreset
          : result.preset_estimates[0]?.id ?? "fast");
        if (!projectName) {
          setProjectName(result.display_name.replace(/\.[^.]+$/, ""));
        }
      } catch (error) {
        setLocalError(String(error));
      } finally {
        setAnalyzing(false);
      }
    },
    [projectName, settings?.default_preset],
  );

  const runPreflight = useCallback(async () => {
    if (!analysis?.valid) return;
    setChecking(true);
    setLocalError(null);
    try {
      const result = await desktopApi.preflightProject({
        sourcePath: analysis.source_path,
        projectRoot,
        preset: selectedPreset,
      });
      setPreflight(result);
      setStep(1);
    } catch (error) {
      setLocalError(String(error));
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
      if (!analysis || !projectName.trim() || !preflight?.can_continue) return;
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
        dispatch({
          type: "ADD_RECENT_PROJECT",
          project: {
            id: result.id,
            name: result.name,
            path: result.path,
            status: result.status,
            updated_at: new Date().toISOString(),
          },
        });
        dispatch({
          type: "NAVIGATE",
          page: { type: "project-detail", projectId: result.id, projectPath: result.path },
        });
        if (startAfterCreate) {
          await desktopApi.startPipeline(result.path);
        }
      } catch (error) {
        setLocalError(String(error));
      } finally {
        setCreating(false);
      }
    },
    [analysis, dispatch, preflight?.can_continue, projectName, projectRoot, selectedPreset],
  );

  const closeWizard = useCallback(() => {
    if (creating) return;
    dispatch({ type: "NAVIGATE", page: { type: "home" } });
  }, [creating, dispatch]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeWizard();
      if (event.altKey && event.key === "ArrowLeft" && step > 0 && !creating) {
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
  }, [closeWizard, createProject, creating, goNext, settings?.create_and_start, step]);

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
            <div key={label} className={`wizard-step ${index === step ? "is-current" : ""} ${index < step ? "is-complete" : ""}`}>
              <span>{index < step ? <Check size={14} weight="bold" /> : index + 1}</span>
              <strong>{label}</strong>
            </div>
          ))}
        </nav>

        <div className="wizard-body">
          {step === 0 && (
            <ImportStep
              analysis={analysis}
              analyzing={analyzing}
              onChoose={chooseSource}
              onClear={() => {
                setAnalysis(null);
                setPreflight(null);
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
              }}
              onRecheck={() => void runPreflight()}
            />
          )}
          {step === 2 && analysis && selectedEstimate && preflight && (
            <ConfirmStep
              analysis={analysis}
              estimate={selectedEstimate}
              projectName={projectName}
              projectRoot={projectRoot}
              onNameChange={setProjectName}
              onChooseRoot={async () => {
                const root = await selectProjectRoot();
                if (root) setProjectRoot(root);
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
            {step > 0 && <button className="button button-secondary" type="button" disabled={creating} onClick={() => setStep((current) => current - 1)}><ArrowLeft size={16} />上一步</button>}
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
                <button className={`button ${settings?.create_and_start === false ? "button-primary" : "button-secondary"}`} type="button" onClick={() => void createProject(false)} disabled={!projectName.trim()}>仅创建项目</button>
                <button className={`button ${settings?.create_and_start === false ? "button-secondary" : "button-primary"}`} type="button" onClick={() => void createProject(true)} disabled={!projectName.trim()}>创建并开始重建</button>
              </>
            )}
          </div>
        </footer>
      </section>
    </div>
  );
}

function ImportStep({ analysis, analyzing, onChoose, onClear }: {
  analysis: MediaAnalysis | null;
  analyzing: boolean;
  onChoose: (kind: "video" | "images") => Promise<void>;
  onClear: () => void;
}) {
  return (
    <section className="wizard-section">
      <div className="wizard-section-heading"><span>1</span><div><h2>导入素材</h2><p>选择一段视频，或选择包含连续照片的文件夹。</p></div></div>
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
              <Metric label="忽略文件" value={`${analysis.image_set_metadata.ignored_count} 个`} />
              <Metric label="总大小" value={formatBytes(analysis.image_set_metadata.total_size_bytes)} />
              <Metric label="格式" value={Object.entries(analysis.image_set_metadata.formats).map(([format, count]) => `${format.toUpperCase()} ${count}`).join(" / ")} />
            </div>
          ) : null}
          {analysis.preset_estimates.length > 0 && (
            <div className="estimate-strip">
              {analysis.preset_estimates.map((preset) => <span key={preset.id}><strong>{presetLabel(preset.id)}</strong>预计 {preset.estimated_frames} 帧</span>)}
            </div>
          )}
          {analysis.blockers.map((blocker) => <div className="inline-blocker" key={blocker}><Warning size={16} />{blocker}</div>)}
        </div>
      )}
      {analyzing && <div className="analysis-loading"><SpinnerGap className="spin" size={18} />正在调用 FFprobe 读取真实媒体信息…</div>}
    </section>
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
      <div className="wizard-section-heading"><span>2</span><div><h2>检查与方案</h2><p>确认引擎、磁盘空间和本次处理参数。</p></div></div>
      <div className={`preflight-summary ${preflight?.can_continue ? "is-ready" : "is-blocked"}`}>
        {checking ? <SpinnerGap className="spin" size={22} /> : preflight?.can_continue ? <CheckCircle size={22} weight="fill" /> : <Warning size={22} weight="fill" />}
        <div><strong>{checking ? "正在检查" : preflight?.can_continue ? "可以开始" : "暂时不能开始"}</strong><span>{preflight?.can_continue ? "素材、引擎和空间检查均已通过" : "请处理下方阻断项后重新检查"}</span></div>
        <button className="button button-secondary" type="button" onClick={onRecheck} disabled={checking}>重新检查</button>
      </div>
      <div className="preflight-columns">
        <div className="preflight-panel"><h3>引擎检查</h3>{preflight?.engine_checks.map((engine) => <div className="check-row" key={engine.name}><span className={engine.available ? "analysis-ok" : "analysis-blocked"}>{engine.available ? <CheckCircle size={16} weight="fill" /> : <Warning size={16} weight="fill" />}</span><strong>{engine.name}</strong><span>{engine.available ? "已就绪" : "未找到"}</span></div>)}</div>
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
    </section>
  );
}

function ConfirmStep({ analysis, estimate, projectName, projectRoot, onNameChange, onChooseRoot }: {
  analysis: MediaAnalysis;
  estimate: PresetEstimate;
  projectName: string;
  projectRoot: string | null;
  onNameChange: (value: string) => void;
  onChooseRoot: () => Promise<void>;
}) {
  return (
    <section className="wizard-section">
      <div className="wizard-section-heading"><span>3</span><div><h2>确认创建</h2><p>素材将复制到项目目录，原始文件不会被修改。</p></div></div>
      <div className="confirm-form">
        <label><span>项目名称</span><input value={projectName} maxLength={80} onChange={(event) => onNameChange(event.target.value)} placeholder="例如：自行车街景测试" autoFocus /></label>
        <label><span>项目保存位置</span><div className="path-picker"><span>{projectRoot ?? "文档 / MetaOrigin Projects（默认）"}</span><button className="button button-secondary" type="button" onClick={() => void onChooseRoot()}><FolderOpen size={16} />更改目录</button></div></label>
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
