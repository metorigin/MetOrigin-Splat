import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { ModalSurface } from "@/components/primitives";
import { registerConfirmationHandler, type ConfirmationRequest } from "@/services/confirmation";

interface PendingConfirmation {
  request: ConfirmationRequest;
  resolve: (confirmed: boolean) => void;
}

/** Stays mounted while pages, the editor and native exit requests await a decision. */
export function ConfirmationProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<PendingConfirmation | null>(null);
  const pendingRef = useRef<PendingConfirmation | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const settle = useCallback((confirmed: boolean) => {
    const current = pendingRef.current;
    if (!current) return;
    pendingRef.current = null;
    setPending(null);
    current.resolve(confirmed);
  }, []);

  useEffect(() => {
    const unregister = registerConfirmationHandler((request) => {
      // A second trigger cannot overwrite the first decision or execute twice.
      if (pendingRef.current) return Promise.resolve(false);
      return new Promise<boolean>((resolve) => {
        const next = { request, resolve };
        pendingRef.current = next;
        setPending(next);
      });
    });
    return () => {
      unregister();
      const current = pendingRef.current;
      pendingRef.current = null;
      current?.resolve(false);
    };
  }, []);

  return <>
    {children}
    {pending && <ModalSurface
      id="application-confirmation"
      title={pending.request.title}
      role="alertdialog"
      className="z-[100] w-[min(460px,calc(100vw-32px))] gap-5"
      initialFocusRef={cancelRef}
      ariaDescribedBy="application-confirmation-description"
      closeOnBackdrop={false}
      onClose={() => settle(false)}
    >
      <p id="application-confirmation-description" className="text-sm leading-relaxed text-muted-foreground">{pending.request.description}</p>
      <div className="flex flex-wrap justify-end gap-2">
        <Button ref={cancelRef} variant="outline" onClick={() => settle(false)}>{pending.request.cancelLabel}</Button>
        <Button variant={pending.request.destructive ? "destructive" : "default"} onClick={() => settle(true)}>{pending.request.confirmLabel}</Button>
      </div>
    </ModalSurface>}
  </>;
}
