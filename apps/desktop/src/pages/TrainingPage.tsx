import { useCallback, useEffect, useState } from "react";
import { useAppContext } from "../context";
import { useTauriCommand, useTauriEvent } from "../hooks";
import { PipelineProgress } from "../components";
import type { PipelineState, TaskProgress } from "../types";

interface TrainingPageProps {
  projectId: string;
  projectPath: string;
}

export function TrainingPage({ projectId, projectPath }: TrainingPageProps) {
  const { dispatch } = useAppContext();

  const startPipelineCmd = useTauriCommand<void>("start_pipeline");
  const cancelPipelineCmd = useTauriCommand<void>("cancel_pipeline");
  const getStateCmd = useTauriCommand<PipelineState>("get_pipeline_state");
  const startPipeline = startPipelineCmd.execute;
  const cancelPipeline = cancelPipelineCmd.execute;
  const getPipelineState = getStateCmd.execute;

  const [pipelineState, setPipelineState] = useState<PipelineState | null>(null);
  const [latestLogs, setLatestLogs] = useState<Record<string, string>>({});
  const [elapsed, setElapsed] = useState(0);
  const [cancelling, setCancelling] = useState(false);
  const [completed, setCompleted] = useState(false);

  // Start pipeline on mount
  useEffect(() => {
    dispatch({ type: "SET_LOADING", loading: true });
    void startPipeline({ projectPath })
      .catch((e) => dispatch({ type: "SET_ERROR", error: String(e) }))
      .finally(() => dispatch({ type: "SET_LOADING", loading: false }));
  }, [dispatch, projectPath, startPipeline]);

  // Listen for real-time events
  useTauriEvent<TaskProgress>("pipeline://progress", (progress) => {
    setLatestLogs((prev) => ({
      ...prev,
      [progress.stage_id]: progress.message,
    }));
  });

  useTauriEvent<void>("pipeline://completed", () => {
    setCompleted(true);
  });

  useTauriEvent<void>("pipeline://cancelled", () => {
    setCancelling(false);
    dispatch({
      type: "NAVIGATE",
      page: { type: "project-detail", projectId, projectPath },
    });
  });

  useTauriEvent<{ error: string }>("pipeline://failed", (payload) => {
    dispatch({ type: "SET_ERROR", error: payload.error });
  });

  // Poll pipeline state
  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        const state = await getPipelineState();
        if (state) {
          setPipelineState(state);
          if (state.overall_progress >= 1.0) {
            setCompleted(true);
          }
        }
      } catch {
        // ignore
      }
    }, 1500);
    return () => clearInterval(interval);
  }, [getPipelineState]);

  // Elapsed timer
  useEffect(() => {
    if (completed) return;
    const interval = setInterval(() => {
      setElapsed((e) => e + 1);
    }, 1000);
    return () => clearInterval(interval);
  }, [completed]);

  const handleCancel = useCallback(async () => {
    setCancelling(true);
    try {
      await cancelPipeline();
    } catch (e) {
      dispatch({ type: "SET_ERROR", error: String(e) });
      setCancelling(false);
    }
  }, [cancelPipeline, dispatch]);

  const formatTime = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}m ${sec}s`;
  };

  const progressPct = pipelineState
    ? Math.round(pipelineState.overall_progress * 100)
    : 0;

  return (
    <div className="page training-page">
      <button
        className="btn btn-text back-button"
        onClick={() =>
          dispatch({
            type: "NAVIGATE",
            page: { type: "project-detail", projectId, projectPath },
          })
        }
        disabled={!completed}
      >
        ← Back
      </button>

      <h1 className="page-title">Training — {projectId}</h1>

      {completed ? (
        <div className="training-completed">
          <div className="completed-icon">🎉</div>
          <h2>Training Completed!</h2>
          <p>Your 3D Gaussian Splat model is ready.</p>
          <div className="completed-actions">
            <button
              className="btn btn-primary"
              onClick={() =>
                dispatch({
                  type: "NAVIGATE",
                  page: { type: "project-detail", projectId, projectPath },
                })
              }
            >
              View Results
            </button>
          </div>
        </div>
      ) : (
        <>
          {/* Overall progress bar */}
          <div className="overall-progress">
            <div className="progress-header">
              <span className="progress-pct">{progressPct}%</span>
              <span className="progress-time">Elapsed: {formatTime(elapsed)}</span>
            </div>
            <div className="pipeline-bar-track overall-track">
              <div
                className="pipeline-bar-fill"
                style={{ width: `${progressPct}%` }}
              />
            </div>
          </div>

          {/* Stage timeline */}
          {pipelineState && (
            <PipelineProgress state={pipelineState} latestLogs={latestLogs} />
          )}

          {/* Cancel button */}
          <div className="cancel-area">
            <button
              className="btn btn-danger"
              onClick={handleCancel}
              disabled={cancelling}
            >
              {cancelling ? "Cancelling..." : "■ Cancel Training"}
            </button>
          </div>
        </>
      )}

      {startPipelineCmd.error && (
        <div className="error-message">{startPipelineCmd.error}</div>
      )}
    </div>
  );
}
