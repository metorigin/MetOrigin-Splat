import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { confirm } from "@tauri-apps/plugin-dialog";
import { ArrowLeft, Save, SpinnerGap } from "../components/primitives/icons";
import { desktopApi } from "../services/desktop";
import { createEditorBridge, type EditorBridge } from "../services/editorBridge";
import type { EditorSession } from "../types";
import "../styles/model-editor.css";

export interface ModelEditorHandle {
  requestLeave: () => Promise<boolean>;
  cancelLeave: () => void;
}

interface Props {
  session: EditorSession;
  onBack: () => void;
}

export default forwardRef<ModelEditorHandle, Props>(function ModelEditorPage({ session, onBack }, ref) {
  const frame = useRef<HTMLIFrameElement>(null);
  const bridge = useRef<EditorBridge | null>(null);
  const mounted = useRef(false);
  const busyRef = useRef(true);
  const closing = useRef(false);
  const saveButton = useRef<HTMLButtonElement>(null);
  const [leaving, setLeaving] = useState(false);
  const [phase, setPhase] = useState<"loading" | "ready" | "saving" | "failed">("loading");
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const initialized = useRef(false);
  const cancelLeave = useCallback(() => { closing.current = false; setLeaving(false); }, []);

  const requestLeave = useCallback(async () => {
    if (phaseRef.current === "saving" || closing.current) return false;
    closing.current = true;
    setLeaving(true);
    saveButton.current?.focus();
    let allowed = false;
    try {
      // Failure to query must never silently discard edits.
      const dirty = phaseRef.current === "loading" ? false : await bridge.current?.request<boolean>("dirty", undefined, [], 3000).result.catch(() => true) ?? true;
      allowed = !dirty || await confirm("当前模型可能有未保存的修改。离开后将丢弃这些修改。", { title: "离开模型编辑", kind: "warning", okLabel: "丢弃并离开", cancelLabel: "继续编辑" });
      return allowed;
    } catch (cause) { setError(String(cause)); return false; }
    // Keep the editor frozen through backend session release and unmount.
    finally { if (!allowed) cancelLeave(); }
  }, [cancelLeave]);
  useImperativeHandle(ref, () => ({ requestLeave, cancelLeave }), [requestLeave, cancelLeave]);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; bridge.current?.dispose(); bridge.current = null; initialized.current = false; };
  }, []);

  const initialize = async () => {
    if (!frame.current?.contentWindow || initialized.current) return;
    initialized.current = true;
    const client = createEditorBridge(frame.current.contentWindow, window.location.origin);
    bridge.current = client;
    try {
      const current = session;
      if (!mounted.current) return;
      // HTML load can precede WebGPU initialization; bounded handshake retries.
      const deadline = Date.now() + 60_000;
      let connected = false;
      while (!connected) {
        if (!mounted.current) return;
        try { await client.request("ping", undefined, [], 1500).result; connected = true; }
        catch { if (Date.now() >= deadline) throw new Error("SuperSplat 启动失败。请确认 WebView2 和显卡驱动支持 WebGPU。可返回结果后重试。"); }
      }
      const bytes = await desktopApi.readGaussianPly(current.project_id, current.project_path, current.source);
      if (!mounted.current) return;
      await client.request("load", { bytes }, [bytes], 180_000).result;
      if (!mounted.current) return;
      setPhase("ready");
    } catch (cause) {
      if (mounted.current) { setError(String(cause)); setPhase("failed"); }
    } finally { busyRef.current = false; }
  };

  const save = async () => {
    if (busyRef.current || closing.current || phase !== "ready" || !bridge.current) return;
    busyRef.current = true;
    phaseRef.current = "saving";
    setPhase("saving"); setError(null); setStatus("");
    saveButton.current?.focus();
    const request = bridge.current.request<ArrayBuffer>("export", undefined, [], 180_000);
    let exported = false;
    let persisted = false;
    try {
      const bytes = await request.result;
      exported = true;
      // Raw IPC avoids expanding hundreds of MB into a JSON array or base64.
      await desktopApi.saveEditedPly(session.session_id, bytes);
      persisted = true;
      await bridge.current.request("saved", { saveId: request.id }).result;
      setStatus("模型已保存。");
    } catch (cause) {
      if (exported) await bridge.current.request("save-failed", { saveId: request.id }, [], 3000).result.catch(() => undefined);
      setError(`${persisted ? "文件已保存，但编辑器状态同步失败" : "保存未完成"}：${String(cause)}`);
    } finally { busyRef.current = false; phaseRef.current = "ready"; setPhase("ready"); }
  };

  return <section className="model-editor-page" aria-label="模型编辑工作区">
    <header className="model-editor-header">
      <div><strong>SuperSplat</strong><span>模型编辑</span></div>
      {status && <span className="model-editor-status" role="status">{status}</span>}
      <div className="model-editor-actions">
        <button type="button" className="button button-secondary workspace-compact-action" onClick={onBack} disabled={phase === "saving" || leaving}><ArrowLeft size={17} />返回</button>
        <button ref={saveButton} type="button" className="button button-secondary workspace-compact-action" onClick={() => void save()} disabled={phase !== "ready" || leaving} aria-label={phase === "saving" ? "正在保存" : "保存"} title={phase === "saving" ? "正在保存模型" : "保存模型"}>{phase === "saving" ? <SpinnerGap size={17} className="spin" /> : <Save size={17} />}保存</button>
      </div>
    </header>
    {error && <div className="model-editor-error" role="alert">{error}</div>}
    <div className="model-editor-content">
      <iframe ref={frame} title="SuperSplat 模型编辑器" src="/supersplat/index.html?lng=zh-CN" onLoad={() => void initialize()} allow="webgpu" />
      {(phase === "loading" || phase === "saving" || leaving) && <div className="model-editor-busy" role="status">
        <div className="model-editor-busy-content">
          <SpinnerGap size={28} className="spin" aria-hidden="true" />
          <span>{leaving ? "正在检查未保存修改…" : phase === "loading" ? "正在载入" : "正在保存模型…"}</span>
        </div>
      </div>}
    </div>
  </section>;
});
