import { useState } from "react";

import { Button } from "./button.tsx";
import { DialogHeader } from "./dialog-header.tsx";
import styles from "./guest-identity-dialog.module.css";
import { ModalDialog } from "./modal-dialog.tsx";
import { TextField } from "./text-field.tsx";

export interface GuestIdentityDialogProps {
  readonly onCancel: () => void;
  readonly onIdentify: (displayName: string) => void;
  readonly open: boolean;
}

export function GuestIdentityDialog({
  onCancel,
  onIdentify,
  open,
}: GuestIdentityDialogProps): React.JSX.Element {
  const [displayName, setDisplayName] = useState("");

  return (
    <ModalDialog
      aria-labelledby="guest-identity-dialog-title"
      className={styles["dialog"]}
      onDismiss={onCancel}
      open={open}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const name = displayName.trim();
          if (name !== "") onIdentify(name);
        }}
      >
        <DialogHeader
          closeLabel="Return to reader"
          eyebrow="Shared document"
          onClose={onCancel}
          title="Join the discussion"
          titleId="guest-identity-dialog-title"
        />
        <TextField
          autoComplete="name"
          autoFocus
          label="Display name"
          maxLength={120}
          onChange={(event) => setDisplayName(event.currentTarget.value)}
          required
          value={displayName}
        />
        <p className={styles["note"]}>This name is shown to other document participants.</p>
        <Button type="submit" variant="primary">
          Join document
        </Button>
      </form>
    </ModalDialog>
  );
}
