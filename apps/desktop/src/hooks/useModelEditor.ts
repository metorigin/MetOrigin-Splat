import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { desktopApi, isDesktopRuntime } from "../services/desktop";
import type { EditorSession, ProjectInfo } from "../types";
import type { ModelEditorHandle } from "../pages/ModelEditorPage";

export function useModelEditor(onError: (message: string) => void) {
  const [session, setSession] = useState<EditorSession | null>(null);
  const sessionRef = useRef(session);
  const editorRef = useRef<ModelEditorHandle>(null);
  const [opening, setOpening] = useState(false);
  const operation = useRef(false);
  const reportError = useRef(onError);
  reportError.current = onError;

  const open = useCallback(async (project: ProjectInfo) => {
    if (operation.current || sessionRef.current) return;
    operation.current = true;
    setOpening(true);
    try {
      const result = await desktopApi.openModelEditor(project.id, project.path);
      sessionRef.current = result;
      setSession(result);
    } catch (error) { reportError.current(`无法打开编辑器：${String(error)}`); }
    finally { operation.current = false; setOpening(false); }
  }, []);

  const leave = useCallback(async (): Promise<boolean> => {
    if (operation.current) return false;
    const current = sessionRef.current;
    if (!current) return true;
    operation.current = true;
    try {
      if (editorRef.current && !await editorRef.current.requestLeave()) return false;
      await desktopApi.closeModelEditor(current.session_id);
      sessionRef.current = null;
      setSession(null);
      return true;
    } catch (error) {
      editorRef.current?.cancelLeave();
      reportError.current(`无法离开编辑器：${String(error)}`);
      return false;
    }
    finally { operation.current = false; }
  }, []);

  useEffect(() => {
    if (!session || !isDesktopRuntime()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    // First close exits editing safely to results. A subsequent close uses the
    // application's normal close behavior, without granting destroy permission.
    void getCurrentWindow().onCloseRequested((event) => {
      event.preventDefault();
      void leave();
    }).then((dispose) => { if (disposed) dispose(); else unlisten = dispose; })
      .catch((error) => reportError.current(`无法注册编辑退出保护：${String(error)}`));
    return () => { disposed = true; unlisten?.(); };
  }, [leave, session]);

  return { session, editorRef, opening, open, leave };
}
