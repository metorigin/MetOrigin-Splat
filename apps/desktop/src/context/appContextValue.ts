import { createContext } from "react";
import type { Dispatch } from "react";

import type { EngineInfo, PipelineSnapshot, ProjectInfo } from "../types";

export type Page =
  | { type: "home" }
  | { type: "new-project" }
  | { type: "project-detail"; projectId: string; projectPath: string };

export interface AppState {
  page: Page;
  recentProjects: ProjectInfo[];
  pipelineSnapshot: PipelineSnapshot | null;
  pipelineSnapshots: Record<string, PipelineSnapshot>;
  engines: EngineInfo[];
  recentProjectsLoading: boolean;
  recentProjectsError: string | null;
  enginesLoading: boolean;
  enginesError: string | null;
  pipelineError: string | null;
  pipelineUpdatedAt: number | null;
  loading: boolean;
  error: string | null;
}

export type Action =
  | { type: "NAVIGATE"; page: Page }
  | { type: "SET_RECENT_PROJECTS"; projects: ProjectInfo[] }
  | { type: "SET_RECENT_PROJECTS_LOADING" }
  | { type: "SET_RECENT_PROJECTS_ERROR"; error: string }
  | { type: "ADD_RECENT_PROJECT"; project: ProjectInfo }
  | { type: "REMOVE_RECENT_PROJECT"; projectId: string }
  | { type: "SET_PIPELINE_SNAPSHOT"; snapshot: PipelineSnapshot | null }
  | { type: "SET_ENGINES"; engines: EngineInfo[] }
  | { type: "SET_ENGINES_LOADING" }
  | { type: "SET_ENGINES_ERROR"; error: string }
  | { type: "SET_PIPELINE_ERROR"; error: string | null }
  | { type: "SET_LOADING"; loading: boolean }
  | { type: "SET_ERROR"; error: string | null };

export interface AppContextValue {
  state: AppState;
  dispatch: Dispatch<Action>;
}

export const initialState: AppState = {
  page: { type: "home" },
  recentProjects: [],
  pipelineSnapshot: null,
  pipelineSnapshots: {},
  engines: [],
  recentProjectsLoading: true,
  recentProjectsError: null,
  enginesLoading: true,
  enginesError: null,
  pipelineError: null,
  pipelineUpdatedAt: null,
  loading: false,
  error: null,
};

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "NAVIGATE":
      return { ...state, page: action.page, error: null };
    case "SET_RECENT_PROJECTS":
      return { ...state, recentProjects: action.projects, recentProjectsLoading: false, recentProjectsError: null };
    case "SET_RECENT_PROJECTS_LOADING":
      return { ...state, recentProjectsLoading: true };
    case "SET_RECENT_PROJECTS_ERROR":
      return { ...state, recentProjectsLoading: false, recentProjectsError: action.error };
    case "ADD_RECENT_PROJECT": {
      const exists = state.recentProjects.some(
        (project) => project.id === action.project.id,
      );
      return {
        ...state,
        recentProjects: exists
          ? state.recentProjects.map((project) =>
              project.id === action.project.id ? action.project : project,
            )
          : [action.project, ...state.recentProjects],
      };
    }
    case "REMOVE_RECENT_PROJECT": {
      const pipelineSnapshots = { ...state.pipelineSnapshots };
      delete pipelineSnapshots[action.projectId];
      return {
        ...state,
        recentProjects: state.recentProjects.filter(
          (project) => project.id !== action.projectId,
        ),
        pipelineSnapshots,
        pipelineSnapshot:
          state.pipelineSnapshot?.project_id === action.projectId
            ? null
            : state.pipelineSnapshot,
      };
    }
    case "SET_PIPELINE_SNAPSHOT": {
      if (!action.snapshot) {
        return { ...state, pipelineSnapshot: null };
      }
      const existing = state.pipelineSnapshots[action.snapshot.project_id];
      // A terminal persisted snapshot is returned with sequence 0 after the
      // active task has left AppState. Other sequence-0 snapshots (especially
      // the one produced while opening a project) must never replace a newer
      // live snapshot.
      const incomingIsTerminal = [
        "paused",
        "cancelled",
        "completed",
        "failed",
      ].includes(action.snapshot.status);
      if (
        existing &&
        action.snapshot.sequence < existing.sequence &&
        !incomingIsTerminal
      ) {
        return state;
      }
      return {
        ...state,
        pipelineSnapshot: action.snapshot,
        pipelineError: null,
        pipelineUpdatedAt: Date.now(),
        pipelineSnapshots: {
          ...state.pipelineSnapshots,
          [action.snapshot.project_id]: action.snapshot,
        },
      };
    }
    case "SET_ENGINES":
      return { ...state, engines: action.engines, enginesLoading: false, enginesError: null };
    case "SET_ENGINES_LOADING":
      return { ...state, enginesLoading: true };
    case "SET_ENGINES_ERROR":
      return { ...state, enginesLoading: false, enginesError: action.error };
    case "SET_PIPELINE_ERROR":
      return { ...state, pipelineError: action.error };
    case "SET_LOADING":
      return { ...state, loading: action.loading };
    case "SET_ERROR":
      return { ...state, error: action.error, loading: false };
  }
}

export const AppContext = createContext<AppContextValue | null>(null);
