import type { ReactElement } from "react";

export interface ToastState {
  id: number;
  text: string;
  visible: boolean;
}

interface ToastProps {
  toast?: ToastState;
}

export function Toast({ toast }: ToastProps): ReactElement {
  const visible = toast?.visible === true;
  return (
    <div className={`toast${visible ? " is-on" : ""}`} role="status" aria-hidden={visible ? undefined : true}>
      {toast ? <span key={toast.id}>{toast.text}</span> : null}
    </div>
  );
}
