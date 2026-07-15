import { ArrowRight, FolderOpen, Plus, Stack, WarningCircle } from "@phosphor-icons/react";

import { useAppContext } from "../context";

export function HomePage({ onRetry }: { onRetry?: () => void }) {
  const { state, dispatch } = useAppContext();
  const firstProject = state.recentProjects[0];

  return (
    <div className="home-workspace">
      <div className="home-workspace-card">
        <span className="home-mark" aria-hidden="true">
          <Stack size={30} weight="fill" />
        </span>
        <p className="eyebrow">3D Gaussian Splat 重建工作区</p>
        <h2>{firstProject ? "继续最近的重建项目" : state.recentProjectsError ? "最近项目暂时不可用" : state.recentProjectsLoading ? "正在加载项目" : "创建第一个重建项目"}</h2>
        <p className="home-description">
          导入视频或照片后，在一个工作区内完成素材准备、相机重建、模型训练和结果导出。
        </p>
        <div className="home-actions">
          <button
            type="button"
            className="button button-primary button-large"
            onClick={() =>
              dispatch({ type: "NAVIGATE", page: { type: "new-project" } })
            }
          >
            <Plus size={18} weight="bold" /> 新建项目
          </button>
          {firstProject && (
            <button
              type="button"
              className="button button-secondary button-large"
              onClick={() =>
                dispatch({
                  type: "NAVIGATE",
                  page: {
                    type: "project-detail",
                    projectId: firstProject.id,
                    projectPath: firstProject.path,
                  },
                })
              }
            >
              <FolderOpen size={18} /> {firstProject.name}
              <ArrowRight size={16} />
            </button>
          )}
          {!firstProject && state.recentProjectsError && onRetry && (
            <button type="button" className="button button-secondary button-large" title={state.recentProjectsError} onClick={onRetry}>
              <WarningCircle size={18} weight="fill" /> 重新加载项目
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
