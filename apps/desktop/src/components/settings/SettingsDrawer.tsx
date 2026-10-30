import { t } from "../../i18n";
import { useEffect, useRef, useState } from "react";
import { desktopApi, selectEngineDirectory, selectEngineExecutable } from "../../services/desktop";
import { normalizeCommandError } from "../../services/errors";
import { useTheme } from "../../hooks/useTheme";
import type { AppSettings, EngineInfo, ResourceMetrics, UiError } from "../../types";
import { ErrorNotice } from "../feedback";
import { LanguageSelector } from "./LanguageSelector";
import { useLanguage } from "../../hooks/useLanguage";
import { TabsContent } from "@/components/ui/tabs";
import { SettingsShell, type SettingsTab } from "./SettingsShell";
import { validStorageLimit } from "./settingsPresentation";
import { GeneralSettings } from "./sections/GeneralSettings";
import { EngineSettings } from "./sections/EngineSettings";
import { PerformanceSettings } from "./sections/PerformanceSettings";
import { AppearanceSettings } from "./sections/AppearanceSettings";
import { DiagnosticsSettings } from "./sections/DiagnosticsSettings";

export function SettingsDrawer({ engines, enginesLoading = false, enginesError = null, version = null, settings, loadError, metrics, projectId, projectPath, onClose, onSettings, onEngines, onError, onRetrySettings }: {
  engines: EngineInfo[];
  enginesLoading?: boolean;
  enginesError?: string | null;
  version?: string | null;
  settings: AppSettings | null;
  loadError?: string | null;
  metrics: ResourceMetrics | null;
  projectId: string | null;
  projectPath: string | null;
  onClose: () => void;
  onSettings: (settings: AppSettings) => void;
  onEngines: (engines: EngineInfo[]) => void;
  onError: (error: string) => void;
  onRetrySettings?: () => void;
}) {
  const { theme, setTheme } = useTheme();
  useLanguage();
  const [tab, setTab] = useState<SettingsTab>("engines");
  const [busy, setBusy] = useState(false);
  const [operationError, setOperationError] = useState<UiError | null>(null);
  const inFlight = useRef(false);
  // Drafts belong to this stable controller so changing categories never loses edits.
  const [logLimit, setLogLimit] = useState(String(settings?.log_retention_mb ?? ""));
  const [cacheLimit, setCacheLimit] = useState(String(settings?.thumbnail_cache_mb ?? ""));
  useEffect(() => { setLogLimit(String(settings?.log_retention_mb ?? "")); }, [settings?.log_retention_mb]);
  useEffect(() => { setCacheLimit(String(settings?.thumbnail_cache_mb ?? "")); }, [settings?.thumbnail_cache_mb]);

  const run = async (action: () => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setOperationError(null);
    try { await action(); } catch (error) {
      // The modal hides outside content from screen readers, so keep failures
      // inside it as well as reporting them to the existing application boundary.
      setOperationError({ ...normalizeCommandError(String(error), "settings_operation"), actions: [] });
      onError(String(error));
    } finally { inFlight.current = false; setBusy(false); }
  };
  const save = (next: AppSettings) => void run(async () => onSettings(await desktopApi.saveAppSettings(next)));
  const refreshEngines = () => void run(async () => onEngines(await desktopApi.checkEngines()));
  const allReady = engines.length > 0 && engines.every((engine) => engine.available);
  const logValid = validStorageLimit(logLimit, 4096);
  const cacheValid = validStorageLimit(cacheLimit, 8192);
  const storageChanged = !!settings && (Number(logLimit) !== settings.log_retention_mb || Number(cacheLimit) !== settings.thumbnail_cache_mb);

  return <SettingsShell tab={tab} onTabChange={setTab} busy={busy} onClose={onClose} loaded={!!settings}>
    {!settings ? <>
      <LanguageSelector />
      <ErrorNotice error={normalizeCommandError(loadError ?? t("设置数据不可用。"), "get_app_settings")} blocking onAction={(action) => {
        if (action.kind === "retry") onRetrySettings?.();
        if (action.kind === "export_diagnostics") onError(t("请先打开一个项目后再导出诊断。"));
      }} />
    </> : <>
      {operationError && <div className="mb-4"><ErrorNotice error={operationError} blocking /></div>}
      <TabsContent value="defaults"><GeneralSettings settings={settings} busy={busy} onSave={save} /></TabsContent>
      <TabsContent value="engines"><EngineSettings engines={engines} loading={enginesLoading} error={enginesError} allReady={allReady} busy={busy} metrics={metrics} version={version}
        onRefresh={refreshEngines}
        onLocateEngine={(name) => void run(async () => { const path = await selectEngineExecutable(name); if (path) { onSettings(await desktopApi.setEngineExecutable(name, path)); onEngines(await desktopApi.checkEngines()); } })}
        onOpenEngine={(name) => void run(async () => { await desktopApi.openEngineLocation(name); })}
        onLocateDirectory={() => void run(async () => { const path = await selectEngineDirectory(); if (path) { onSettings(await desktopApi.setEngineDirectory(path)); onEngines(await desktopApi.checkEngines()); } })}
      /></TabsContent>
      <TabsContent value="performance"><PerformanceSettings settings={settings} metrics={metrics} busy={busy} logLimit={logLimit} cacheLimit={cacheLimit} logValid={logValid} cacheValid={cacheValid} storageChanged={storageChanged}
        onLogLimit={setLogLimit} onCacheLimit={setCacheLimit} onSave={save}
        onSaveStorage={() => save({ ...settings, log_retention_mb: Number(logLimit), thumbnail_cache_mb: Number(cacheLimit) })}
      /></TabsContent>
      <TabsContent value="appearance"><AppearanceSettings theme={theme} onTheme={setTheme} /></TabsContent>
      <TabsContent value="diagnostics"><DiagnosticsSettings allReady={allReady} canExport={!!projectPath && !!projectId} busy={busy}
        onExport={() => projectPath && projectId && void run(async () => { const result = await desktopApi.exportDiagnostics(projectPath); const fileName = result.path.split(/[\\/]/).pop(); if (!fileName) throw new Error(t("诊断包路径无效。")); await desktopApi.openProjectLocation({ projectId, projectPath, targetType: "artifact", relativePath: `output/${fileName}` }); })}
      /></TabsContent>
    </>}
  </SettingsShell>;
}
