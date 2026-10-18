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
  return (
    <div className={`toast${toast?.visible ? " is-on" : ""}`} role="status">
      {toast?.text}
    </div>
  );
}
