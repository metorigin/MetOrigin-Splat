import { ArrowLeft, FolderOpen, Plus } from "../primitives/icons";

import type { Page } from "../../context";

interface WorkspaceHeaderProps {
  page: Exclude<Page, { type: "project-detail" }>;
  onNewProject: () => void;
  onOpenProject: () => void;
  onBackHome: () => void;
}

export function WorkspaceHeader({
  page,
  onNewProject,
  onOpenProject,
  onBackHome,
}: WorkspaceHeaderProps) {
  if (page.type === "new-project") {
    return (
      <header className="workspace-context-header" aria-labelledby="workspace-page-title">
        <div>
          <p className="workspace-context-eyebrow">项目创建</p>
          <h1 id="workspace-page-title">创建新项目</h1>
          <p>选择素材、完成检查并确认处理方案。</p>
        </div>
        <button type="button" className="button button-secondary" onClick={onBackHome}>
          <ArrowLeft size={16} /> 返回项目中心
        </button>
      </header>
    );
  }

  return (
    <header className="workspace-context-header" aria-labelledby="workspace-page-title">
      <div>
        <p className="workspace-context-eyebrow">项目管理</p>
        <h1 id="workspace-page-title">项目中心</h1>
        <p>从最近项目继续，或创建一次新的 3D 重建。</p>
      </div>
      <div className="workspace-context-actions" role="group" aria-label="项目中心操作">
        <button type="button" className="button button-secondary" onClick={onOpenProject}>
          <FolderOpen size={16} /> 打开项目
        </button>
        <button type="button" className="button button-primary" onClick={onNewProject}>
          <Plus size={16} /> 新建项目
        </button>
      </div>
    </header>
  );
}
