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
      <strong>{redactSensitiveText(receipt.title)}</strong>
      <p>{redactSensitiveText(receipt.message)}</p>
      {receipt.dismissible && onDismiss ? (
        <button type="button" onClick={onDismiss}>关闭</button>
      ) : null}
    </section>
  );
}
