import { createContext } from "react";
import type { Dispatch } from "react";

import type { EngineInfo, PipelineState, ProjectInfo } from "../types";

export type Page =
  | { type: "home" }
  | { type: "new-project" }
  | { type: "project-detail"; projectId: string; projectPath: string }
  | { type: "training"; projectId: string; projectPath: string };

export interface AppState {
  page: Page;
  recentProjects: ProjectInfo[];
  pipelineState: PipelineState | null;
  engines: EngineInfo[];
  loading: boolean;
  error: string | null;
}

export type Action =
  | { type: "NAVIGATE"; page: Page }
  | { type: "SET_RECENT_PROJECTS"; projects: ProjectInfo[] }
  | { type: "ADD_RECENT_PROJECT"; project: ProjectInfo }
  | { type: "SET_PIPELINE_STATE"; state: PipelineState | null }
  | { type: "SET_ENGINES"; engines: EngineInfo[] }
  | { type: "SET_LOADING"; loading: boolean }
  | { type: "SET_ERROR"; error: string | null };

export interface AppContextValue {
  state: AppState;
  dispatch: Dispatch<Action>;
}

export const initialState: AppState = {
  page: { type: "home" },
  recentProjects: [],
  pipelineState: null,
  engines: [],
  loading: false,
  error: null,
};

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "NAVIGATE":
      return { ...state, page: action.page, error: null };
    case "SET_RECENT_PROJECTS":
      return { ...state, recentProjects: action.projects };
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
    case "SET_PIPELINE_STATE":
      return { ...state, pipelineState: action.state };
    case "SET_ENGINES":
      return { ...state, engines: action.engines };
    case "SET_LOADING":
      return { ...state, loading: action.loading };
    case "SET_ERROR":
      return { ...state, error: action.error, loading: false };
  }
}

export const AppContext = createContext<AppContextValue | null>(null);
