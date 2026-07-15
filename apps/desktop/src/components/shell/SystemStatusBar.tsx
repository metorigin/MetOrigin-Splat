import {
  CheckCircle,
  Cpu,
  HardDrives,
  Monitor,
  WarningCircle,
} from "@phosphor-icons/react";

import type { EngineInfo, ResourceMetrics } from "../../types";

interface SystemStatusBarProps {
  engines: EngineInfo[];
  enginesLoading: boolean;
  enginesError: string | null;
  version: string | null;
  metrics: ResourceMetrics | null;
  onOpenSettings: () => void;
  onRetryEngines: () => void;
}

function gib(bytes: number) {
  return (bytes / 1024 / 1024 / 1024).toFixed(1);
}

export function SystemStatusBar({ engines, enginesLoading, enginesError, version, metrics, onOpenSettings, onRetryEngines }: SystemStatusBarProps) {
  return (
    <footer className="system-status-bar">
      <div className="status-bar-group engine-status-group">
        <span className="status-bar-label">引擎版本</span>
        {enginesLoading && engines.length === 0 && (
          <span className="status-item is-warning">
            <WarningCircle size={14} weight="fill" /> 正在检测
          </span>
        )}
        {enginesError && (
          <button type="button" className="status-item is-warning" title={`引擎检测失败：${enginesError}`} onClick={onRetryEngines}>
            <WarningCircle size={14} weight="fill" /> 检测失败，重试
          </button>
        )}
        {engines.map((engine) => (
          <button
            type="button"
            className={`status-item ${engine.available ? "is-success" : "is-warning"}`}
            key={engine.name}
            title={engine.path ?? `${engine.name} 未定位`}
            onClick={onOpenSettings}
          >
            {engine.available ? (
              <CheckCircle size={14} weight="fill" />
            ) : (
              <WarningCircle size={14} weight="fill" />
            )}
            {engine.name} {engine.version ?? "未定位"}
          </button>
        ))}
      </div>
      <button type="button" className="status-bar-group" onClick={onOpenSettings}>
        <Cpu size={15} />
        <span className="status-bar-label">GPU</span>
        <span>{metrics?.gpu ? `${metrics.gpu.name} · ${metrics.gpu.utilization_percent?.toFixed(0) ?? "—"}%` : "指标不可用"}</span>
      </button>
      <button type="button" className="status-bar-group" onClick={onOpenSettings}>
        <HardDrives size={15} />
        <span className="status-bar-label">VRAM</span>
        <span>{metrics?.gpu ? `${gib(metrics.gpu.memory_used_bytes)} / ${gib(metrics.gpu.memory_total_bytes)} GB` : "尚未测量"}</span>
      </button>
      <button type="button" className="status-bar-group status-system-group" onClick={onOpenSettings}>
        <Monitor size={15} />
        <span>{metrics?.operating_system ?? "Windows"}</span>
        {version && <span>应用 v{version}</span>}
      </button>
    </footer>
  );
}
