import { useCallback, useEffect, useMemo, useRef } from "react";

import type { Action } from "../context/appContextValue";
import { desktopApi } from "../services/desktop";
import type {
  ProjectAvailabilityResult,
  ProjectInfo,
  RecentProjectAvailability,
} from "../types";

const MAX_CONCURRENT_PROBES = 4;

export function useProjectAvailability(
  projects: ProjectInfo[],
  availability: Record<string, RecentProjectAvailability>,
  dispatch: React.Dispatch<Action>,
) {
  const inFlight = useRef(new Map<string, Promise<void>>());
  const generations = useRef(new Map<string, number>());
  const availabilityRef = useRef(availability);
  availabilityRef.current = availability;
  const signature = useMemo(
    () => projects.map((project) => `${project.id}\u0000${project.path}`).join("\u0001"),
    [projects],
  );
  const projectsRef = useRef(projects);
  projectsRef.current = projects;

  const checkProject = useCallback((project: ProjectInfo): Promise<void> => {
    const key = `${project.id}\u0000${project.path}`;
    const existing = inFlight.current.get(key);
    if (existing) return existing;
    const currentGeneration = availabilityRef.current[project.id]?.generation ?? -1;
    const generation = Math.max(generations.current.get(project.id) ?? -1, currentGeneration) + 1;
    generations.current.set(project.id, generation);
    dispatch({
      type: "BEGIN_PROJECT_AVAILABILITY",
      projectId: project.id,
      projectPath: project.path,
      generation,
    });
    const operation = desktopApi.checkRecentProjectAvailability(project.id, project.path)
      .catch((): ProjectAvailabilityResult => ({
        project_id: project.id,
        checked_path: project.path,
        availability: "check_failed",
        checked_at: new Date().toISOString(),
        reason_code: "UI-PROJECT-PATH-CHECK-REQUEST",
        refreshed_project: null,
      }))
      .then((result) => {
        dispatch({ type: "SET_PROJECT_AVAILABILITY", result, generation });
      })
      .finally(() => {
        if (inFlight.current.get(key) === operation) inFlight.current.delete(key);
      });
    inFlight.current.set(key, operation);
    return operation;
  }, [dispatch]);

  useEffect(() => {
    const queue = [...projectsRef.current];
    let cursor = 0;
    const worker = async () => {
      while (cursor < queue.length) {
        const project = queue[cursor];
        cursor += 1;
        await checkProject(project);
      }
    };
    void Promise.all(
      Array.from({ length: Math.min(MAX_CONCURRENT_PROBES, queue.length) }, () => worker()),
    );
  }, [checkProject, signature]);

  const retryProjectAvailability = useCallback((projectId: string) => {
    const project = projectsRef.current.find((item) => item.id === projectId);
    return project ? checkProject(project) : Promise.resolve();
  }, [checkProject]);

  return { retryProjectAvailability };
}
