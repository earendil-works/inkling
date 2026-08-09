import { useEffect, useRef } from "react";
import type { DialogHTMLAttributes } from "react";

import styles from "./modal-dialog.module.css";

export interface ModalDialogProps extends Omit<
  DialogHTMLAttributes<HTMLDialogElement>,
  "onCancel" | "open"
> {
  readonly onDismiss: () => void;
  readonly open: boolean;
  readonly preventDismiss?: boolean | undefined;
}

export function ModalDialog({
  className,
  onDismiss,
  open,
  preventDismiss = false,
  ...dialogProps
}: ModalDialogProps): React.JSX.Element {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      {...dialogProps}
      className={[styles["dialog"], className].filter(Boolean).join(" ")}
      onCancel={(event) => {
        event.preventDefault();
        if (!preventDismiss) onDismiss();
      }}
      ref={dialogRef}
    />
  );
}
