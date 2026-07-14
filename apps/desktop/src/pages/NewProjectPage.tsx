import {
  ArrowLeft,
  CheckCircle,
  FilmStrip,
  Images,
  Sparkle,
} from "@phosphor-icons/react";
import { useCallback, useState } from "react";
import { useAppContext } from "../context";
import { useTauriCommand } from "../hooks";
import { selectImageDirectory, selectVideoFile } from "../services/desktop";
import type { CreateProjectResult, MediaAnalysis, PresetOption } from "../types";

const PRESETS: PresetOption[] = [
  {
    id: "fast",
    name: "快速预览",
    description: "低分辨率，适合快速查看效果",
    estimated_time: "约 3 分钟",
    iterations: 3000,
  },
  {
    id: "balanced",
    name: "均衡",
    description: "兼顾质量与处理速度",
    estimated_time: "约 10 分钟",
    iterations: 7000,
  },
  {
    id: "quality",
    name: "高质量",
    description: "最高质量，处理时间较长",
    estimated_time: "约 45 分钟",
    iterations: 30000,
  },
];

export function NewProjectPage() {
  const { dispatch } = useAppContext();

  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [selectedPreset, setSelectedPreset] = useState("balanced");
  const [projectName, setProjectName] = useState("");

  const analyzeCmd = useTauriCommand<MediaAnalysis>("analyze_media");
  const createCmd = useTauriCommand<CreateProjectResult>("create_project");
  const analyzeMedia = analyzeCmd.execute;
  const createProject = createCmd.execute;

  const handleSourceSelect = useCallback(async (kind: "video" | "images") => {
    try {
      const path =
        kind === "video"
          ? await selectVideoFile()
          : await selectImageDirectory();
      if (!path) return;
      setSelectedFile(path);
      await analyzeMedia({ path });
    } catch (error) {
      dispatch({ type: "SET_ERROR", error: String(error) });
    }
  }, [analyzeMedia, dispatch]);

  const handleCreate = useCallback(async () => {
    if (!selectedFile || !projectName.trim()) return;

    try {
      dispatch({ type: "SET_LOADING", loading: true });
      const result = await createProject({
        name: projectName.trim(),
        sourcePath: selectedFile,
        preset: selectedPreset,
      });

      if (result) {
        dispatch({
          type: "NAVIGATE",
          page: {
            type: "project-detail",
            projectId: result.id,
            projectPath: result.path,
          },
        });
      }
    } catch (e) {
      dispatch({ type: "SET_ERROR", error: String(e) });
    } finally {
      dispatch({ type: "SET_LOADING", loading: false });
    }
  }, [selectedFile, projectName, selectedPreset, createProject, dispatch]);

  const analysisResult = analyzeCmd.data;

  return (
    <div className="page new-project-page">
      <button
        className="btn btn-text back-button"
        onClick={() => dispatch({ type: "NAVIGATE", page: { type: "home" } })}
      >
        <ArrowLeft size={16} /> 返回工作区
      </button>

      <h1 className="page-title">新建项目</h1>

      {/* Step 1: Select Source */}
      <section className="form-section">
        <h2 className="form-step">第 1 步：选择源媒体</h2>
        <div className={`file-select-area ${selectedFile ? "has-selection" : ""}`}>
          {selectedFile ? (
            <div className="file-selected">
              <span className="file-selected-icon"><CheckCircle size={24} weight="fill" /></span>
              <div>
                <strong>已选择素材</strong>
                <span className="file-path">{selectedFile}</span>
              </div>
            </div>
          ) : (
            <div className="file-prompt">
              <FilmStrip className="file-prompt-icon" size={32} />
              <p>从视频或一组照片创建重建项目</p>
              <p className="file-hint">选择器会在 Windows 原生窗口中打开</p>
            </div>
          )}
          <div className="source-select-actions">
            <button
              type="button"
              className="button button-primary"
              onClick={() => void handleSourceSelect("video")}
            >
              <FilmStrip size={18} /> 选择视频
            </button>
            <button
              type="button"
              className="button button-secondary"
              onClick={() => void handleSourceSelect("images")}
            >
              <Images size={18} /> 选择图片文件夹
            </button>
          </div>
        </div>

        {analyzeCmd.loading && (
          <div className="loading-indicator">正在分析媒体…</div>
        )}

        {analyzeCmd.error && (
          <div className="error-message">{analyzeCmd.error}</div>
        )}

        {analysisResult?.warning && (
          <div className="warning-message">{analysisResult.warning}</div>
        )}

        {analysisResult && analysisResult.valid && (
          <div className="analysis-result">
            {analysisResult.type === "video" ? (
              analysisResult.video_metadata ? (
                <div className="video-info">
                  <span>
                    {analysisResult.video_metadata.width}×
                    {analysisResult.video_metadata.height},{" "}
                    {analysisResult.video_metadata.fps.toFixed(1)} 帧/秒，{" "}
                    {analysisResult.video_metadata.duration_seconds.toFixed(1)} 秒
                  </span>
                  <span>编码 {analysisResult.video_metadata.codec.toUpperCase()}</span>
                  <span>预计 {analysisResult.estimated_frames} 帧</span>
                  <span>预计占用 {analysisResult.estimated_disk_mb} MB</span>
                </div>
              ) : (
                <div className="video-info"><span>视频元数据尚未读取</span></div>
              )
            ) : (
              <div className="image-info">
                <span>找到 {analysisResult.image_count} 张图片</span>
                <span>预计占用 {analysisResult.estimated_disk_mb} MB</span>
              </div>
            )}
          </div>
        )}
      </section>

      {/* Step 2: Choose Preset */}
      <section className="form-section">
        <h2 className="form-step">第 2 步：选择质量预设</h2>
        <div className="preset-cards">
          {PRESETS.map((preset) => (
            <div
              key={preset.id}
              className={`preset-card ${selectedPreset === preset.id ? "selected" : ""}`}
              onClick={() => setSelectedPreset(preset.id)}
            >
              <div className="preset-name">{preset.name}</div>
              <div className="preset-desc">{preset.description}</div>
              <div className="preset-time">{preset.estimated_time}</div>
            </div>
          ))}
        </div>
      </section>

      {/* Step 3: Project Name */}
      <section className="form-section">
        <h2 className="form-step">第 3 步：填写项目名称</h2>
        <input
          type="text"
          className="text-input"
          placeholder="例如：博物馆展厅"
          value={projectName}
          onChange={(e) => setProjectName(e.target.value)}
        />
      </section>

      {/* Create button */}
      <button
        className="button button-primary button-large btn-create"
        onClick={handleCreate}
        disabled={!selectedFile || !projectName.trim() || createCmd.loading}
      >
        {createCmd.loading ? (
          "正在创建…"
        ) : (
          <><Sparkle size={18} weight="fill" /> 创建项目</>
        )}
      </button>

      {createCmd.error && (
        <div className="error-message" style={{ marginTop: "1rem" }}>
          {createCmd.error}
        </div>
      )}
    </div>
  );
}
