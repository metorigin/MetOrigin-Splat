// Adapted from Jan containers/SettingsMenu.tsx and routes/settings/interface.tsx.
// Copyright Menlo Research. Apache-2.0; see integrations/jan/LICENSE.
import { useRef, useSyncExternalStore, type ReactNode } from "react";
import { SlidersHorizontal, Cpu, HardDrive, Palette, Stethoscope, X } from "lucide-react";
import { t } from "@/i18n";
import { ModalSurface } from "@/components/primitives";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

const settingsTabs = ["defaults", "engines", "performance", "appearance", "diagnostics"] as const;
export type SettingsTab = typeof settingsTabs[number];
const icons = { defaults: SlidersHorizontal, engines: Cpu, performance: HardDrive, appearance: Palette, diagnostics: Stethoscope };
const label = (tab: SettingsTab) => ({ defaults: t("常规"), engines: t("引擎"), performance: t("性能与存储"), appearance: t("外观"), diagnostics: t("诊断") })[tab];
const compactQuery = "(max-width: 767px)";
function subscribe(onChange: () => void) {
  const media = window.matchMedia?.(compactQuery);
  media?.addEventListener("change", onChange);
  return () => media?.removeEventListener("change", onChange);
}
const compactSnapshot = () => window.matchMedia?.(compactQuery).matches ?? false;

/** A stable modal with Jan's category rail and separately scrolling content. */
export function SettingsShell({ tab, onTabChange, busy, onClose, loaded, children }: {
  tab: SettingsTab;
  onTabChange: (tab: SettingsTab) => void;
  busy: boolean;
  onClose: () => void;
  loaded: boolean;
  children: ReactNode;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const compact = useSyncExternalStore(subscribe, compactSnapshot);
  return <ModalSurface id="settings-drawer" title={t("应用设置")} titleHidden
    className="flex h-[min(760px,calc(100dvh-32px))] w-[min(1000px,calc(100vw-32px))] flex-col overflow-hidden bg-background p-0 sm:max-w-none"
    onClose={onClose} busy={busy} initialFocusRef={closeRef} returnFallbackId="desktop-sidebar-toggle">
    <header className="flex h-[60px] shrink-0 items-center justify-between px-5">
      <h2 className="text-base font-medium">{t("设置与引擎")}</h2>
      <Button ref={closeRef} variant="ghost" size="icon-sm" disabled={busy} onClick={onClose} aria-label={t("关闭设置")}><X size={18} /></Button>
    </header>
    {loaded ? <Tabs value={tab} onValueChange={(value) => onTabChange(value as SettingsTab)} orientation={compact ? "horizontal" : "vertical"} className="flex min-h-0 flex-1 gap-0 max-md:flex-col">
      <TabsList aria-label={t("设置分类")} className="mx-2 mb-3 grid h-auto w-[232px] shrink-0 content-start justify-stretch gap-1 rounded-none bg-transparent p-1.5 max-md:mx-3 max-md:mb-2 max-md:w-auto max-md:grid-cols-5 max-md:p-0">
        {settingsTabs.map((value) => {
          const Icon = icons[value];
          return <TabsTrigger key={value} value={value} onClick={() => onTabChange(value)} className="h-auto min-h-9 flex-none justify-start gap-2 rounded-md border-0 px-2 py-2 text-left font-medium text-foreground data-[state=active]:bg-secondary data-[state=active]:shadow-none hover:bg-secondary/60 max-md:flex-col max-md:justify-center max-md:px-1 max-md:text-center max-md:text-xs max-md:leading-snug max-md:whitespace-normal"><Icon size={18} className="text-muted-foreground" /><span>{label(value)}</span></TabsTrigger>;
        })}
      </TabsList>
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto px-4 pb-5">{children}</div>
    </Tabs> : <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 pb-5">{children}</div>}
  </ModalSurface>;
}
