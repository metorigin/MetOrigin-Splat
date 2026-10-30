import { localizeMessage, t } from "../../i18n";
import type { ActionReceipt as ActionReceiptModel } from "../../types";
import { redactSensitiveText } from "../../services/errors";
import { CheckCircle, WarningCircle } from "../primitives/icons";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function ActionReceipt({ receipt, onDismiss }: {
  receipt: ActionReceiptModel;
  onDismiss?: () => void;
}) {
  const failed = receipt.status === "error";
  return (
    <Alert
      variant={failed ? "destructive" : "default"}
      className={cn(
        "fixed right-6 bottom-12 z-[70] w-[min(25rem,calc(100vw-3rem))] bg-popover text-popover-foreground shadow-lg [[role=dialog]_&]:static [[role=dialog]_&]:w-full [[role=dialog]_&]:shadow-none [[role=alertdialog]_&]:static [[role=alertdialog]_&]:w-full [[role=alertdialog]_&]:shadow-none",
        !failed && "border-success/40",
      )}
      role={failed ? "alert" : "status"}
      aria-atomic="true"
    >
      {failed ? <WarningCircle size={16} /> : <CheckCircle size={16} className="text-success" />}
      <AlertTitle className="line-clamp-none break-words leading-relaxed">{redactSensitiveText(localizeMessage(receipt.title))}</AlertTitle>
      <AlertDescription className="space-y-3">
        <p className="break-words">{redactSensitiveText(localizeMessage(receipt.message))}</p>
        {receipt.dismissible && onDismiss ? <Button variant="outline" size="sm" onClick={onDismiss}>{t("关闭")}</Button> : null}
      </AlertDescription>
    </Alert>
  );
}
