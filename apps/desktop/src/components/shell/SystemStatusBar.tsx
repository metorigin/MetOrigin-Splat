import {
  CheckCircle,
  Cpu,
  HardDrives,
  Monitor,
  WarningCircle,
} from "@phosphor-icons/react";

import type { EngineInfo } from "../../types";

interface SystemStatusBarProps {
  engines: EngineInfo[];
  version: string | null;
}

export function SystemStatusBar({ engines, version }: SystemStatusBarProps) {
  return (
    <footer className="system-status-bar">
      <div className="status-bar-group engine-status-group">
        <span className="status-bar-label">引擎版本</span>
        {engines.length === 0 && (
          <span className="status-item is-warning">
            <WarningCircle size={14} weight="fill" /> 正在检测
          </span>
        )}
        {engines.map((engine) => (
          <button
            type="button"
            className={`status-item ${engine.available ? "is-success" : "is-warning"}`}
            key={engine.name}
            title={engine.path ?? `${engine.name} 未定位`}
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
      <div className="status-bar-group">
        <Cpu size={15} />
        <span className="status-bar-label">GPU</span>
        <span>尚未测量</span>
      </div>
      <div className="status-bar-group">
        <HardDrives size={15} />
        <span className="status-bar-label">VRAM</span>
        <span>尚未测量</span>
      </div>
      <div className="status-bar-group status-system-group">
        <Monitor size={15} />
        <span>Windows</span>
        {version && <span>应用 v{version}</span>}
      </div>
    </footer>
  );
}
