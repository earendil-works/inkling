import { useState } from "react";

import { Button } from "./button.tsx";
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
    <ModalDialog className="guest-identity-dialog" onDismiss={onCancel} open={open}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const name = displayName.trim();
          if (name !== "") onIdentify(name);
        }}
      >
        <div className="dialog-heading">
          <div>
            <p className="eyebrow">Shared document</p>
            <h2>Join the discussion</h2>
          </div>
          <Button aria-label="Return to reader" onClick={onCancel} variant="icon">
            ×
          </Button>
        </div>
        <TextField
          autoComplete="name"
          autoFocus
          label="Display name"
          maxLength={120}
          onChange={(event) => setDisplayName(event.currentTarget.value)}
          required
          value={displayName}
        />
        <p className="dialog-note">This name is shown to other document participants.</p>
        <Button type="submit" variant="primary">
          Join document
        </Button>
      </form>
    </ModalDialog>
  );
}
