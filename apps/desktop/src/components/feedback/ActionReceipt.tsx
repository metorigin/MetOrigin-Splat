import { localizeMessage, t } from "../../i18n";
import type { ActionReceipt as ActionReceiptModel } from "../../types";
import { redactSensitiveText } from "../../services/errors";
import { Notification } from "./Notification";

function successMessage(receipt: ActionReceiptModel): string {
  switch (receipt.action) {
    case "delete_project": return receipt.affectedResources.includes("project_storage") ? t("项目已删除") : t("项目记录已移除");
    case "delete_checkpoint": return t("恢复点已删除");
    case "restore_checkpoint": return t("已恢复所选恢复点");
    case "pause": return t("已请求暂停任务");
    case "cancel": return t("已请求取消任务");
    case "rerun_stage": return t("阶段已重置");
    default: return t("操作已完成");
  }
}

export function ActionReceipt({ receipt, onDismiss, placement = "toast" }: {
  receipt: ActionReceiptModel;
  onDismiss?: () => void;
  placement?: "inline" | "toast";
}) {
  const failed = receipt.status === "error";
  const message = placement === "toast" && !failed
    ? successMessage(receipt)
    : redactSensitiveText(localizeMessage(failed ? receipt.error?.message || receipt.message || receipt.title : receipt.message));
  return (
    <Notification
      key={receipt.id}
      variant={failed ? "error" : "success"}
      placement={placement}
      title={redactSensitiveText(localizeMessage(receipt.title))}
      message={message}
      onDismiss={placement === "toast" || receipt.dismissible ? onDismiss : undefined}
    />
  );
}
