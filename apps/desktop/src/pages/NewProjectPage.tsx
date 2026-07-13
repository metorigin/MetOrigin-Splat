import { useCallback, useState } from "react";
import { useAppContext } from "../context";
import { useTauriCommand } from "../hooks";
import type { CreateProjectResult, MediaAnalysis, PresetOption } from "../types";

const PRESETS: PresetOption[] = [
  {
    id: "fast",
    name: "Quick Preview",
    description: "Low resolution, ~3 minutes",
    estimated_time: "~3 min",
    iterations: 3000,
  },
  {
    id: "balanced",
    name: "Balanced",
    description: "Good quality, ~10 minutes",
    estimated_time: "~10 min",
    iterations: 7000,
  },
  {
    id: "quality",
    name: "High Quality",
    description: "Best quality, ~45 minutes",
    estimated_time: "~45 min",
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

  const handleFileSelect = useCallback(async () => {
    // In Tauri v2, we use the dialog API or an input
    // For now, use a prompt or file input
    const path = window.prompt("Enter the path to your video or image folder:");
    if (!path) return;

    setSelectedFile(path);
    try {
      await analyzeMedia({ path });
    } catch {
      // Error is handled by the hook
    }
  }, [analyzeMedia]);

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
        ← Back
      </button>

      <h1 className="page-title">New Project</h1>

      {/* Step 1: Select Source */}
      <section className="form-section">
        <h2 className="form-step">Step 1: Select Source Media</h2>
        <div className="file-select-area" onClick={handleFileSelect}>
          {selectedFile ? (
            <div className="file-selected">
              <span className="file-icon">📁</span>
              <span className="file-path">{selectedFile}</span>
            </div>
          ) : (
            <div className="file-prompt">
              <span className="file-icon">🎥</span>
              <p>Click to select a video or image folder</p>
              <p className="file-hint">Supported: MP4, MOV, JPG, PNG</p>
            </div>
          )}
        </div>

        {analyzeCmd.loading && (
          <div className="loading-indicator">Analyzing media...</div>
        )}

        {analyzeCmd.error && (
          <div className="error-message">{analyzeCmd.error}</div>
        )}

        {analysisResult && analysisResult.valid && (
          <div className="analysis-result">
            {analysisResult.type === "video" && analysisResult.video_metadata ? (
              <div className="video-info">
                <span>
                  {analysisResult.video_metadata.width}×
                  {analysisResult.video_metadata.height},{" "}
                  {analysisResult.video_metadata.fps.toFixed(1)}fps,{" "}
                  {analysisResult.video_metadata.duration_seconds.toFixed(0)}s
                </span>
                <span>~{analysisResult.estimated_frames} frames</span>
                <span>~{analysisResult.estimated_disk_mb} MB estimated</span>
              </div>
            ) : (
              <div className="image-info">
                <span>{analysisResult.image_count} images found</span>
                <span>~{analysisResult.estimated_disk_mb} MB estimated</span>
              </div>
            )}
          </div>
        )}
      </section>

      {/* Step 2: Choose Preset */}
      <section className="form-section">
        <h2 className="form-step">Step 2: Choose Quality Preset</h2>
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
        <h2 className="form-step">Step 3: Project Name</h2>
        <input
          type="text"
          className="text-input"
          placeholder="e.g. museum-room"
          value={projectName}
          onChange={(e) => setProjectName(e.target.value)}
        />
      </section>

      {/* Create button */}
      <button
        className="btn btn-primary btn-large btn-create"
        onClick={handleCreate}
        disabled={!selectedFile || !projectName.trim() || createCmd.loading}
      >
        {createCmd.loading ? "Creating..." : "✦ Create Project"}
      </button>

      {createCmd.error && (
        <div className="error-message" style={{ marginTop: "1rem" }}>
          {createCmd.error}
        </div>
      )}
    </div>
  );
}
