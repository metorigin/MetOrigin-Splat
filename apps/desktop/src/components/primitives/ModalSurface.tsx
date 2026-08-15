import { createPortal } from "react-dom";
import { useLayoutEffect, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";

import { useModalFocus } from "../../hooks/useModalFocus";

interface ModalSurfaceProps {
  id: string;
  title: string;
  titleHidden?: boolean;
  children: ReactNode;
  onClose: () => void;
  busy?: boolean;
  role?: "dialog" | "alertdialog";
  className?: string;
  initialFocusRef?: RefObject<HTMLElement>;
  returnFallbackId?: string;
  closeOnBackdrop?: boolean;
  ariaDescribedBy?: string;
}

export function ModalSurface({
  id,
  title,
  titleHidden = false,
  children,
  onClose,
  busy = false,
  role = "dialog",
  className = "",
  initialFocusRef,
  returnFallbackId,
  closeOnBackdrop = true,
  ariaDescribedBy,
}: ModalSurfaceProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [host] = useState(() => {
    const element = document.createElement("div");
    element.dataset.modalHost = id;
    return element;
  });

  useLayoutEffect(() => {
    document.body.appendChild(host);
    return () => host.remove();
  }, [host]);

  useModalFocus({
    id,
    containerRef,
    host,
    busy,
    onClose,
    initialFocusRef,
    returnFallbackId,
  });

  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (
          closeOnBackdrop &&
          !busy &&
          event.target === event.currentTarget
        ) {
          onClose();
        }
      }}
    >
      <div
        ref={containerRef}
        id={id}
        className={`modal-surface ${className}`.trim()}
        role={role}
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={ariaDescribedBy}
        aria-busy={busy || undefined}
        tabIndex={-1}
      >
        <h2 id={`${id}-title`} className={titleHidden ? "visually-hidden" : undefined} tabIndex={-1}>
          {title}
        </h2>
        {children}
      </div>
    </div>,
    host,
  );
}
