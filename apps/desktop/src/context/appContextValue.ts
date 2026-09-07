import { createContext } from "react";
import type { Dispatch } from "react";

import type {
  EngineInfo,
  PipelineSnapshot,
  ProjectAvailabilityResult,
  ProjectInfo,
  RecentProjectAvailability,
} from "../types";

export type Page =
  | { type: "home" }
  | { type: "new-project" }
  | { type: "project-detail"; projectId: string; projectPath: string };

export interface AppState {
  page: Page;
  recentProjects: ProjectInfo[];
  projectAvailability: Record<string, RecentProjectAvailability>;
  pipelineSnapshot: PipelineSnapshot | null;
  pipelineSnapshots: Record<string, PipelineSnapshot>;
  pipelineUpdatedAtByProject: Record<string, number>;
  activePipelineProjectId: string | null;
  pipelineConflict: {
    requestedProjectId: string;
    activeProjectId: string;
  } | null;
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
  | { type: "BEGIN_PROJECT_AVAILABILITY"; projectId: string; projectPath: string; generation: number }
  | { type: "SET_PROJECT_AVAILABILITY"; result: ProjectAvailabilityResult; generation: number }
  | { type: "RELINK_RECENT_PROJECT"; project: ProjectInfo; previousPath: string }
  | { type: "SET_PIPELINE_SNAPSHOT"; snapshot: PipelineSnapshot | null }
  | { type: "SET_ACTIVE_PIPELINE"; snapshot: PipelineSnapshot | null }
  | {
      type: "SET_PIPELINE_CONFLICT";
      requestedProjectId: string;
      activeProjectId: string;
    }
  | { type: "CLEAR_PIPELINE_CONFLICT"; requestedProjectId?: string }
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
  projectAvailability: {},
  pipelineSnapshot: null,
  pipelineSnapshots: {},
  pipelineUpdatedAtByProject: {},
  activePipelineProjectId: null,
  pipelineConflict: null,
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

function unknownAvailability(
  projectPath: string,
  generation = 0,
): RecentProjectAvailability {
  return {
    status: "unknown",
    checkedPath: projectPath,
    checkedAt: null,
    reasonCode: null,
    generation,
  };
}

function isNonRegressingProjectUpdate(current: ProjectInfo, incoming: ProjectInfo): boolean {
  const currentTime = Date.parse(current.updated_at);
  const incomingTime = Date.parse(incoming.updated_at);
  return Number.isFinite(currentTime) && Number.isFinite(incomingTime) && incomingTime >= currentTime;
}

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "NAVIGATE":
      return { ...state, page: action.page, error: null };
    case "SET_RECENT_PROJECTS":
      return {
        ...state,
        recentProjects: action.projects,
        projectAvailability: Object.fromEntries(action.projects.map((project) => {
          const current = state.projectAvailability[project.id];
          return [
            project.id,
            current?.checkedPath === project.path
              ? current
              : unknownAvailability(project.path, (current?.generation ?? -1) + 1),
          ];
        })),
        recentProjectsLoading: false,
        recentProjectsError: null,
      };
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
        projectAvailability: {
          ...state.projectAvailability,
          [action.project.id]: state.projectAvailability[action.project.id]?.checkedPath === action.project.path
            ? state.projectAvailability[action.project.id]
            : unknownAvailability(
                action.project.path,
                (state.projectAvailability[action.project.id]?.generation ?? -1) + 1,
              ),
        },
      };
    }
    case "REMOVE_RECENT_PROJECT": {
      const pipelineSnapshots = { ...state.pipelineSnapshots };
      const pipelineUpdatedAtByProject = { ...state.pipelineUpdatedAtByProject };
      delete pipelineSnapshots[action.projectId];
      delete pipelineUpdatedAtByProject[action.projectId];
      const projectAvailability = { ...state.projectAvailability };
      delete projectAvailability[action.projectId];
      return {
        ...state,
        recentProjects: state.recentProjects.filter(
          (project) => project.id !== action.projectId,
        ),
        pipelineSnapshots,
        pipelineUpdatedAtByProject,
        projectAvailability,
        activePipelineProjectId:
          state.activePipelineProjectId === action.projectId
            ? null
            : state.activePipelineProjectId,
        pipelineConflict:
          state.pipelineConflict?.activeProjectId === action.projectId ||
          state.pipelineConflict?.requestedProjectId === action.projectId
            ? null
            : state.pipelineConflict,
        pipelineSnapshot:
          state.pipelineSnapshot?.project_id === action.projectId
            ? null
            : state.pipelineSnapshot,
      };
    }
    case "BEGIN_PROJECT_AVAILABILITY": {
      const project = state.recentProjects.find((item) => item.id === action.projectId);
      const current = state.projectAvailability[action.projectId];
      if (!project || project.path !== action.projectPath) return state;
      if (current && action.generation < current.generation) return state;
      return {
        ...state,
        projectAvailability: {
          ...state.projectAvailability,
          [action.projectId]: {
            status: "checking",
            checkedPath: action.projectPath,
            checkedAt: current?.checkedPath === action.projectPath ? current.checkedAt : null,
            reasonCode: null,
            generation: action.generation,
          },
        },
      };
    }
    case "SET_PROJECT_AVAILABILITY": {
      const currentAvailability = state.projectAvailability[action.result.project_id];
      const projectIndex = state.recentProjects.findIndex(
        (project) => project.id === action.result.project_id && project.path === action.result.checked_path,
      );
      if (
        projectIndex < 0 ||
        !currentAvailability ||
        currentAvailability.checkedPath !== action.result.checked_path ||
        currentAvailability.generation !== action.generation
      ) {
        return state;
      }
      const projects = [...state.recentProjects];
      const currentProject = projects[projectIndex];
      const refreshed = action.result.refreshed_project;
      if (
        refreshed &&
        refreshed.id === currentProject.id &&
        refreshed.path === currentProject.path &&
        isNonRegressingProjectUpdate(currentProject, refreshed)
      ) {
        const active = state.activePipelineProjectId === currentProject.id
          ? state.pipelineSnapshots[currentProject.id]
          : null;
        projects[projectIndex] = active ? {
          ...refreshed,
          status: active.status,
          stage_label: active.state.current_stage ?? undefined,
        } : refreshed;
      }
      return {
        ...state,
        recentProjects: projects,
        projectAvailability: {
          ...state.projectAvailability,
          [action.result.project_id]: {
            status: action.result.availability,
            checkedPath: action.result.checked_path,
            checkedAt: action.result.checked_at,
            reasonCode: action.result.reason_code,
            generation: action.generation,
          },
        },
      };
    }
    case "RELINK_RECENT_PROJECT": {
      const recordExists = state.recentProjects.some(
        (project) => project.id === action.project.id && project.path === action.previousPath,
      );
      if (!recordExists) return state;
      const currentAvailability = state.projectAvailability[action.project.id];
      return {
        ...state,
        recentProjects: state.recentProjects.map((project) =>
          project.id === action.project.id && project.path === action.previousPath
            ? action.project
            : project,
        ),
        projectAvailability: {
          ...state.projectAvailability,
          [action.project.id]: unknownAvailability(
            action.project.path,
            (currentAvailability?.generation ?? -1) + 1,
          ),
        },
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
        pipelineUpdatedAtByProject: {
          ...state.pipelineUpdatedAtByProject,
          [action.snapshot.project_id]: Date.now(),
        },
      };
    }
    case "SET_ACTIVE_PIPELINE": {
      if (!action.snapshot) {
        return {
          ...state,
          activePipelineProjectId: null,
          pipelineConflict: null,
        };
      }
      const existing = state.pipelineSnapshots[action.snapshot.project_id];
      if (existing && action.snapshot.sequence < existing.sequence) return state;
      const updatedAt = Date.now();
      return {
        ...state,
        activePipelineProjectId: action.snapshot.project_id,
        pipelineSnapshots: {
          ...state.pipelineSnapshots,
          [action.snapshot.project_id]: action.snapshot,
        },
        pipelineUpdatedAtByProject: {
          ...state.pipelineUpdatedAtByProject,
          [action.snapshot.project_id]: updatedAt,
        },
        pipelineError: null,
        pipelineUpdatedAt: updatedAt,
      };
    }
    case "SET_PIPELINE_CONFLICT":
      return {
        ...state,
        pipelineConflict: {
          requestedProjectId: action.requestedProjectId,
          activeProjectId: action.activeProjectId,
        },
      };
    case "CLEAR_PIPELINE_CONFLICT":
      if (
        action.requestedProjectId &&
        state.pipelineConflict?.requestedProjectId !== action.requestedProjectId
      ) {
        return state;
      }
      return { ...state, pipelineConflict: null };
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

export function selectProjectPipelineSnapshot(
  state: AppState,
  projectId: string | null | undefined,
): PipelineSnapshot | null {
  return projectId ? state.pipelineSnapshots[projectId] ?? null : null;
}

export function selectActivePipelineSnapshot(state: AppState): PipelineSnapshot | null {
  return selectProjectPipelineSnapshot(state, state.activePipelineProjectId);
}

export function selectPipelineFreshness(
  state: AppState,
  projectId: string | null | undefined,
  staleAfterMs = 15_000,
): { updatedAt: number | null; stale: boolean } {
  const updatedAt = projectId ? state.pipelineUpdatedAtByProject[projectId] ?? null : null;
  return {
    updatedAt,
    stale: updatedAt != null && Date.now() - updatedAt > staleAfterMs,
  };
}

export function selectPipelineConflict(
  state: AppState,
  requestedProjectId: string | null | undefined,
): AppState["pipelineConflict"] {
  return requestedProjectId && state.pipelineConflict?.requestedProjectId === requestedProjectId
    ? state.pipelineConflict
    : null;
}

export const AppContext = createContext<AppContextValue | null>(null);
