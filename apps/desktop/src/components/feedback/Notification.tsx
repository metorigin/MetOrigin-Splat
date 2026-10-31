import { isValidElement, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type Ref } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import { t } from "@/i18n";
import { Button } from "@/components/ui/button";
import { CheckCircle, Info, WarningCircle, X } from "../primitives/icons";
import "./notifications.css";

export interface NotificationProps {
  variant?: "info" | "success" | "warning" | "error";
  title?: ReactNode;
  message?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  onDismiss?: () => void;
  dismissLabel?: string;
  role?: "alert" | "status";
  placement?: "inline" | "toast";
  className?: string;
  ref?: Ref<HTMLDivElement>;
  tabIndex?: number;
  id?: string;
}

const toastStacks = new WeakMap<Document, { element: HTMLDivElement; users: number }>();

function ToastPortal({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    // Toasts from pages and app-level actions share one layout owner so they
    // cannot overlap even when they are rendered by independent components.
    let stack = toastStacks.get(document);
    if (!stack) {
      const element = document.createElement("div");
      element.className = "feedback-notification-stack";
      document.body.appendChild(element);
      stack = { element, users: 0 };
      toastStacks.set(document, stack);
    }
    stack.users += 1;
    setTarget(stack.element);
    return () => {
      stack.users -= 1;
      if (stack.users === 0) {
        stack.element.remove();
        toastStacks.delete(document);
      }
    };
  }, []);
  return target ? createPortal(children, target) : null;
}

function notificationText(value: ReactNode): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(notificationText).join("");
  if (isValidElement<{ children?: ReactNode }>(value)) return notificationText(value.props.children);
  return "";
}

/** Toasts expire together with their owning state; inline feedback stays put. */
export function Notification({ variant = "info", title, message, children, actions, onDismiss, dismissLabel, role, placement = "inline", className, ref, tabIndex, id }: NotificationProps) {
  const identity = JSON.stringify([variant, notificationText(title), notificationText(message), notificationText(children), notificationText(actions), id]);
  const generation = useMemo(() => ({ identity, placement }), [identity, placement]);
  const currentGeneration = useRef(generation);
  currentGeneration.current = generation;
  const dismissedGeneration = useRef<object | null>(null);
  const [hiddenGeneration, setHiddenGeneration] = useState<object | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const dismissCallback = useRef(onDismiss);
  dismissCallback.current = onDismiss;
  const dismiss = useCallback(() => {
    if (placement === "toast") {
      if (currentGeneration.current !== generation || dismissedGeneration.current === generation) return;
      dismissedGeneration.current = generation;
      window.clearTimeout(timer.current);
      setHiddenGeneration(generation);
    }
    dismissCallback.current?.();
  }, [generation, placement]);
  useEffect(() => {
    if (placement !== "toast") return;
    const handle = window.setTimeout(dismiss, 5000);
    timer.current = handle;
    return () => {
      window.clearTimeout(handle);
      if (timer.current === handle) timer.current = undefined;
    };
  }, [dismiss, placement]);

  if (hiddenGeneration === generation) return null;
  const Icon = variant === "success" ? CheckCircle : variant === "info" ? Info : WarningCircle;
  const content = <div
    ref={ref}
    tabIndex={tabIndex}
    id={id}
    className={cn("feedback-notification", `feedback-notification--${variant}`, placement === "toast" && "feedback-notification--toast", className)}
    data-feedback-variant={variant}
    role={role ?? (variant === "error" ? "alert" : "status")}
    aria-atomic="true"
  >
    <Icon size={19} className="feedback-notification__icon" aria-hidden="true" />
    <div className="feedback-notification__content">
      {title && (placement !== "toast" || !message) && <div className="feedback-notification__title">{title}</div>}
      {message && <div className="feedback-notification__message" title={placement === "toast" ? notificationText(message) : undefined}>{message}</div>}
      {children && <div className="feedback-notification__details">{children}</div>}
      {actions && <div className="feedback-notification__actions">{actions}</div>}
    </div>
    {(onDismiss || placement === "toast") && <Button variant="ghost" size="icon-sm" className="feedback-notification__dismiss" onClick={dismiss} aria-label={dismissLabel ?? t("关闭")}><X size={16} aria-hidden="true" /></Button>}
  </div>;
  return placement === "toast" ? <ToastPortal>{content}</ToastPortal> : content;
}

export function NotificationStack({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
