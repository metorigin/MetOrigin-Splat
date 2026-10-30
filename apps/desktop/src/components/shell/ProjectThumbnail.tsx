import { useState } from "react";
import { t } from "../../i18n";
import type { ProjectInfo, RecentProjectAvailability } from "../../types";
import { useProjectThumbnail } from "../../hooks/useProjectThumbnail";
import { FolderOpen, ImageSquare, SpinnerGap } from "../primitives/icons";

export function ProjectThumbnail({ project, availability }: {
  project: ProjectInfo;
  availability?: RecentProjectAvailability;
}) {
  const { containerRef, data, status } = useProjectThumbnail(project, availability);
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const locationUnavailable = availability?.checkedPath === project.path
    && ["missing", "unreadable"].includes(availability.status);
  const showImage = status === "ready" && data !== null && data.data_url !== failedSource && !locationUnavailable;
  const label = status === "loading" ? t("正在加载素材预览")
    : locationUnavailable ? t("项目位置不可用")
      : status === "error" || (data !== null && data.data_url === failedSource) ? t("素材预览不可用")
        : t("暂无素材预览");

  return <span ref={containerRef} className="flex size-full items-center justify-center overflow-hidden rounded-md bg-muted/40" title={showImage ? t("素材预览") : label}>
    {showImage ? <img src={data.data_url} alt={t("{0}的素材预览", project.name)}
      width={data.width} height={data.height} decoding="async" loading="lazy" draggable={false}
      className="size-full object-cover" onError={() => setFailedSource(data.data_url)} />
      : <span role="img" aria-label={label} className="text-muted-foreground/70">
        {status === "loading" ? <SpinnerGap className="size-7 motion-safe:animate-spin" aria-hidden="true" />
          : locationUnavailable ? <FolderOpen className="size-8" aria-hidden="true" />
            : <ImageSquare className="size-8" aria-hidden="true" />}
      </span>}
  </span>;
}
