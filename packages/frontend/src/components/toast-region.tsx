import { useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { Ref } from "react";

import type { ToastKind } from "../app-context.tsx";

interface ToastMessage {
  readonly id: number;
  readonly kind: ToastKind;
  readonly message: string;
}

export interface ToastController {
  readonly show: (message: string, kind: ToastKind) => void;
}

export interface ToastRegionProps {
  readonly ref?: Ref<ToastController> | undefined;
}

export function ToastRegion({ ref }: ToastRegionProps): React.JSX.Element {
  const [toasts, setToasts] = useState<readonly ToastMessage[]>([]);
  const nextIdRef = useRef(0);
  const timersRef = useRef(new Set<number>());

  const show = useCallback((message: string, kind: ToastKind): void => {
    const id = ++nextIdRef.current;
    setToasts((current) => [...current, { id, kind, message }]);
    const timer = window.setTimeout(() => {
      timersRef.current.delete(timer);
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }, 4_000);
    timersRef.current.add(timer);
  }, []);

  useImperativeHandle(ref, () => ({ show }), [show]);
  useEffect(
    () => () => {
      for (const timer of timersRef.current) window.clearTimeout(timer);
      timersRef.current.clear();
    },
    [],
  );

  return (
    <div className="toast-region" data-toasts="" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div className={`toast toast--${toast.kind}`} key={toast.id}>
          {toast.message}
        </div>
      ))}
    </div>
  );
}
