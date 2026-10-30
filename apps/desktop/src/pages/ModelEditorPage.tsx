import { Button } from "@/components/ui/button";
import { localizeMessage, t, getLocale } from "../i18n";
import { useLanguage } from "../hooks/useLanguage";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, Save, SpinnerGap } from "../components/primitives/icons";
import { desktopApi } from "../services/desktop";
import { createEditorBridge, type EditorBridge } from "../services/editorBridge";
import type { EditorSession } from "../types";
import janTheme from "../../../../integrations/jan/theme.json";

// The editing surface has its own dark palette; the shared titlebar keeps the
// application's selected appearance and never changes the loaded scene.
const editorThemeStyle: CSSProperties = {
  colorScheme: "dark",
  ...Object.fromEntries(Object.entries(janTheme.dark).map(([key, value]) => [
    `--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`,
    value,
  ])),
};

export interface ModelEditorHandle {
  requestLeave: () => Promise<boolean>;
  cancelLeave: () => void;
}

interface Props {
  session: EditorSession;
  onBack: () => void;
  headerTarget?: HTMLElement | null;
}

export default forwardRef<ModelEditorHandle, Props>(function ModelEditorPage({ session, onBack, headerTarget }, ref) {
  const { locale } = useLanguage();
  // Keep the frame URL stable: reloading it would discard unsaved GPU edits.
  const editorUrl = useRef(`/supersplat/index.html?lng=${getLocale()}`);
  const frame = useRef<HTMLIFrameElement>(null);
  const bridge = useRef<EditorBridge | null>(null);
  const mounted = useRef(false);
  const busyRef = useRef(true);
  const closing = useRef(false);
  const saveButton = useRef<HTMLButtonElement>(null);
  const [leaving, setLeaving] = useState(false);
  const [phase, setPhase] = useState<"loading" | "ready" | "saving" | "exporting" | "failed">("loading");
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [themeError, setThemeError] = useState(false);
  const [themeReady, setThemeReady] = useState(false);
  const themeGeneration = useRef(0);
  const syncTheme = useCallback(async (client: EditorBridge) => {
    const generation = ++themeGeneration.current;
    try {
      const applied = await client.request("theme", { theme: "dark", version: "jan-v1" }, [], 3000).result;
      if (applied !== true) throw new Error("Invalid theme acknowledgement.");
      if (mounted.current && generation === themeGeneration.current) {
        setThemeReady(true);
        setThemeError(false);
      }
    } catch {
      if (mounted.current && generation === themeGeneration.current) setThemeError(true);
    }
  }, []);
  const initialized = useRef(false);
  const cancelLeave = useCallback(() => { closing.current = false; setLeaving(false); }, []);

  const requestLeave = useCallback(async () => {
    if (phaseRef.current === "saving" || phaseRef.current === "exporting" || closing.current) return false;
    closing.current = true;
    setLeaving(true);
    saveButton.current?.focus();
    let allowed = false;
    try {
      // Failure to query must never silently discard edits.
      const dirty = phaseRef.current === "loading" ? false : await bridge.current?.request<boolean>("dirty", undefined, [], 3000).result.catch(() => true) ?? true;
      allowed = !dirty || await desktopApi.confirm(t("当前模型可能有未保存的修改。离开后将丢弃这些修改。"), { title: t("离开模型编辑"), kind: "warning", okLabel: t("丢弃并离开"), cancelLabel: t("继续编辑") });
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

  useEffect(() => {
    if (phase !== "ready" || !bridge.current) return;
    let disposed = false;
    void bridge.current.request("language", { locale }).result.catch((cause) => {
      if (!disposed) setError(t("无法切换编辑器语言：{0}", String(cause)));
    });
    return () => { disposed = true; };
  }, [locale, phase]);

  const initialize = async () => {
    if (!frame.current?.contentWindow || initialized.current) return;
    initialized.current = true;
    const client = createEditorBridge(frame.current.contentWindow, window.location.origin, {
      imageExport: {
        begin: () => {
          if (!mounted.current || closing.current || busyRef.current || phaseRef.current !== "ready") {
            throw new Error(t("编辑器正忙，请稍后导出图像。"));
          }
          busyRef.current = true;
          phaseRef.current = "exporting";
          setPhase("exporting");
          setStatus("");
        },
        save: (format, bytes) => desktopApi.saveEditorImage(session.session_id, format, bytes),
        end: () => {
          busyRef.current = false;
          phaseRef.current = "ready";
          if (mounted.current) setPhase("ready");
        },
      },
    });
    bridge.current = client;
    try {
      const current = session;
      if (!mounted.current) return;
      // HTML load can precede WebGPU initialization; bounded handshake retries.
      const deadline = Date.now() + 60_000;
      let connected = false;
      while (!connected) {
        if (!mounted.current) return;
        try { await client.request("ping", { nativeImageSave: true }, [], 1500).result; connected = true; }
        catch { if (Date.now() >= deadline) throw new Error(t("SuperSplat 启动失败。请确认 WebView2 和显卡驱动支持 WebGPU。可返回结果后重试。")); }
      }
      // Keep the frame hidden until import and a dark-theme acknowledgement
      // complete. A failed theme update can be retried without replacing the scene.
      await syncTheme(client);
      const [bytes, camera] = await Promise.all([
        desktopApi.readGaussianPly(current.project_id, current.project_path, current.source),
        // A saved model can remain editable without its original SfM metadata.
        desktopApi.getGaussianCamera(current.project_id, current.project_path).catch(() => null),
      ]);
      if (!mounted.current) return;
      await client.request("load", { bytes, camera }, [bytes], 180_000).result;
      if (!mounted.current) return;
      await syncTheme(client);
      if (!mounted.current) return;
      phaseRef.current = "ready";
      setPhase("ready");
    } catch (cause) {
      if (mounted.current) { setError(String(cause)); setPhase("failed"); }
    } finally { busyRef.current = false; }
  };

  const save = async () => {
    if (busyRef.current || closing.current || phaseRef.current !== "ready" || !themeReady || !bridge.current) return;
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
      setStatus(t("模型已保存。"));
    } catch (cause) {
      if (exported) await bridge.current.request("save-failed", { saveId: request.id }, [], 3000).result.catch(() => undefined);
      setError(`${persisted ? t("文件已保存，但编辑器状态同步失败") : t("保存未完成")}：${String(cause)}`);
    } finally { busyRef.current = false; phaseRef.current = "ready"; setPhase("ready"); }
  };

  const frameVisible = themeReady && phase !== "loading" && phase !== "failed";
  const header = <header className={headerTarget ? "model-editor-header flex h-full min-w-0 flex-1 items-center justify-between gap-3 px-2 text-foreground" : "model-editor-header flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-3"}>
      <div className="flex min-w-0 items-baseline gap-3"><strong className="font-semibold">SuperSplat</strong><span className="text-xs text-muted-foreground">{t("模型编辑")}</span></div>
      {status && <span className="model-editor-status ml-auto text-xs text-muted-foreground" role="status">{localizeMessage(status)}</span>}
      <div className="model-editor-actions flex shrink-0 gap-2">
        <Button variant="outline" size="sm" type="button" onClick={onBack} disabled={phase === "saving" || phase === "exporting" || leaving}><ArrowLeft size={17} />{t("返回")}</Button>
        <Button variant="outline" size="sm" ref={saveButton} type="button" onClick={() => void save()} disabled={phase !== "ready" || !themeReady || leaving} aria-label={phase === "saving" ? t("正在保存") : t("保存")} title={phase === "saving" ? t("正在保存模型") : t("保存模型")}>{phase === "saving" ? <SpinnerGap size={17} className="spin" /> : <Save size={17} />}{t("保存")}</Button>
      </div>
    </header>;

  return <section className="model-editor-page flex h-full min-h-0 min-w-0 flex-1 flex-col bg-card text-foreground" data-theme="dark" style={editorThemeStyle} aria-label={t("模型编辑工作区")}>
    {headerTarget ? createPortal(header, headerTarget) : header}
    {error && <div className="model-editor-error shrink-0 border-b border-destructive/30 bg-destructive/10 px-5 py-3 text-sm text-destructive" role="alert">{localizeMessage(error)}</div>}
    {themeError && <div className="flex shrink-0 items-center gap-3 border-b border-border bg-muted px-5 py-2 text-sm" role="status"><span>{t("编辑器外观未同步，模型修改已保留。")}</span><Button size="sm" variant="outline" onClick={() => { if (bridge.current) void syncTheme(bridge.current); }}>{t("重试")}</Button></div>}
    <div className="model-editor-content relative min-h-0 flex-1 bg-background">
      <iframe className="block size-full border-0" style={{ visibility: frameVisible ? "visible" : "hidden" }} aria-hidden={!frameVisible} ref={frame} title={t("SuperSplat 模型编辑器")} src={editorUrl.current} onLoad={() => void initialize()} allow="webgpu" />
      {(phase === "loading" || phase === "saving" || phase === "exporting" || leaving) && <div className="model-editor-busy absolute inset-0 grid place-items-center bg-background text-sm text-foreground" role="status">
        <div className="model-editor-busy-content flex flex-col items-center gap-3">
          <SpinnerGap size={28} className="spin" aria-hidden="true" />
          <span>{leaving ? t("正在检查未保存修改…") : phase === "loading" ? t("正在载入") : phase === "exporting" ? t("正在导出图像…") : t("正在保存模型…")}</span>
        </div>
      </div>}
    </div>
  </section>;
});
