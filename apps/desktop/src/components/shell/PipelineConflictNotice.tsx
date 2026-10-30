import { Button } from "@/components/ui/button";
import { t } from "../../i18n";
import { ArrowRight } from "../primitives/icons";
import { Notification } from "../feedback";

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
    <Notification variant="warning"
      id={id}
      role={assertive ? "alert" : "status"}
      title={<>{conflict.activeProjectName}{t("正在运行")}</>}
      message={<>{getProjectStatusLabel(conflict.status)} · {conflict.stageLabel ? getStageLabel(conflict.stageLabel) : t("正在准备")} · {progress}{t("。 当前项目不会启动、取消或进入队列。")}</>}
      actions={<Button type="button" variant="outline" size="sm" onClick={onReturn}>
        {t("返回活动项目")}<ArrowRight size={15} />
      </Button>}
    />
  );
}
