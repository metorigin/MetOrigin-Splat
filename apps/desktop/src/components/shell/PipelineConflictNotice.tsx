import { Button } from "@/components/ui/button";
import { t } from "../../i18n";
import { ArrowRight, WarningCircle } from "../primitives/icons";

import { getProjectStatusLabel, getStageLabel } from "../../localization";
import type { PipelineConflictInfo } from "../../types";

interface PipelineConflictNoticeProps {
  id: string;
  conflict: PipelineConflictInfo;
  assertive?: boolean;
  onReturn: () => void;
}

export function PipelineConflictNotice({
  id,
  conflict,
  assertive = false,
  onReturn,
}: PipelineConflictNoticeProps) {
  const progress = conflict.progress == null
    ? t("进度正在估算")
    : t("进度 {0}%", Math.round(conflict.progress * 100));
  return (
    <div
      id={id}
      className="flex flex-wrap items-center gap-3 rounded-lg border border-warning/30 bg-warning/5 p-4 text-sm [&>svg]:text-warning [&>div]:min-w-0 [&>div]:flex-1 [&_p]:mt-1 [&_p]:text-xs [&_p]:text-muted-foreground"
      role={assertive ? "alert" : "status"}
    >
      <WarningCircle size={18} aria-hidden="true" />
      <div>
        <strong>{conflict.activeProjectName}{t("正在运行")}</strong>
        <p>
          {getProjectStatusLabel(conflict.status)} · {conflict.stageLabel ? getStageLabel(conflict.stageLabel) : t("正在准备")} · {progress}{t("。 当前项目不会启动、取消或进入队列。")}</p>
      </div>
      <Button type="button" variant="outline" size="sm" onClick={onReturn}>
        {t("返回活动项目")}<ArrowRight size={15} />
      </Button>
    </div>
  );
}
