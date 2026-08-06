import { useId } from "react";
import type { ReactNode } from "react";

import { Button } from "./button.tsx";
import { ModalDialog } from "./modal-dialog.tsx";

export interface ConfirmationDialogProps {
  readonly confirmLabel: string;
  readonly description: ReactNode;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
  readonly open: boolean;
  readonly pending?: boolean | undefined;
  readonly title: string;
  readonly tone?: "danger" | "default" | undefined;
}

export function ConfirmationDialog({
  confirmLabel,
  description,
  onCancel,
  onConfirm,
  open,
  pending = false,
  title,
  tone = "default",
}: ConfirmationDialogProps): React.JSX.Element {
  const titleId = useId();
  const descriptionId = useId();

  return (
    <ModalDialog
      aria-describedby={descriptionId}
      aria-labelledby={titleId}
      className="confirmation-dialog"
      onDismiss={onCancel}
      open={open}
      preventDismiss={pending}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onConfirm();
        }}
      >
        <div>
          <p className="eyebrow">Please confirm</p>
          <h2 id={titleId}>{title}</h2>
        </div>
        <p className="dialog-note" id={descriptionId}>
          {description}
        </p>
        <div className="confirmation-dialog__actions">
          <Button disabled={pending} onClick={onCancel} variant="toolbar">
            Cancel
          </Button>
          <Button
            className={tone === "danger" ? "confirmation-dialog__danger" : undefined}
            disabled={pending}
            type="submit"
            variant="primary"
          >
            {pending ? "Working…" : confirmLabel}
          </Button>
        </div>
      </form>
    </ModalDialog>
  );
}
