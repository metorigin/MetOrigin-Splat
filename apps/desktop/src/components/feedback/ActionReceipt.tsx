import { localizeMessage, t } from "../../i18n";
import type { ActionReceipt as ActionReceiptModel } from "../../types";
import { redactSensitiveText } from "../../services/errors";

export function ActionReceipt({
  receipt,
  onDismiss,
}: {
  receipt: ActionReceiptModel;
  onDismiss?: () => void;
}) {
  return (
    <section
      className={`action-receipt ${receipt.status}`}
      role={receipt.status === "error" ? "alert" : "status"}
    >
      <strong>{localizeMessage(redactSensitiveText(receipt.title))}</strong>
      <p>{localizeMessage(redactSensitiveText(receipt.message))}</p>
      {receipt.dismissible && onDismiss ? (
        <button type="button" onClick={onDismiss}>{t("关闭")}</button>
      ) : null}
    </section>
  );
}
