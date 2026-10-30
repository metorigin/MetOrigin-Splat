/** Application confirmation boundary. The stable shell supplies the presentation. */
export interface ConfirmationRequest {
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel: string;
  destructive?: boolean;
}

type ConfirmationHandler = (request: ConfirmationRequest) => Promise<boolean>;
let handler: ConfirmationHandler | null = null;

export function registerConfirmationHandler(next: ConfirmationHandler): () => void {
  handler = next;
  return () => { if (handler === next) handler = null; };
}

/** Missing or disposed UI must never grant permission to mutate or discard data. */
export function requestConfirmation(request: ConfirmationRequest): Promise<boolean> {
  if (!handler) return Promise.resolve(false);
  try { return handler(request).catch(() => false); }
  catch { return Promise.resolve(false); }
}
