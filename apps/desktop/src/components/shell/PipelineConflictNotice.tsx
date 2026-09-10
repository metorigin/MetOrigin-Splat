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
      className="pipeline-conflict-notice"
      role={assertive ? "alert" : "status"}
    >
      <WarningCircle size={18} weight="fill" aria-hidden="true" />
      <div>
        <strong>{conflict.activeProjectName}{t("正在运行")}</strong>
        <p>
          {getProjectStatusLabel(conflict.status)} · {conflict.stageLabel ? getStageLabel(conflict.stageLabel) : t("正在准备")} · {progress}{t("。 当前项目不会启动、取消或进入队列。")}</p>
      </div>
      <button type="button" className="button button-secondary" onClick={onReturn}>
        {t("返回活动项目")}<ArrowRight size={15} />
      </button>
    </div>
  );
}
