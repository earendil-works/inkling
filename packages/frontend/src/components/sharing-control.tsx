import { useEffect, useState } from "react";
import { Effect } from "effect";

import type { ShareResponse } from "@earendil-works/jot-protocol";

import type { ApiClientService, ApiError } from "../api.ts";
import { useAppContext } from "../app-context.tsx";
import { useEffectAction } from "../effect-hooks.ts";
import { browserRuntime } from "../effect-runtime.ts";
import { Button } from "./button.tsx";
import { DialogHeader } from "./dialog-header.tsx";
import { FormError } from "./form-error.tsx";
import { ModalDialog } from "./modal-dialog.tsx";
import { SelectField } from "./select-field.tsx";

type ShareAccess = "disabled" | "view" | "comment" | "edit";

export interface SharingControlProps {
  readonly access: ShareAccess;
  readonly api: ApiClientService;
  readonly documentId: string;
  readonly expectedRevision: number;
  readonly onUpdated: (response: ShareResponse) => void;
}

export function SharingControl({
  access,
  api,
  documentId,
  expectedRevision,
  onUpdated,
}: SharingControlProps): React.JSX.Element {
  const { showToast } = useAppContext();
  const [open, setOpen] = useState(false);
  const [selectedAccess, setSelectedAccess] = useState<ShareAccess>(access);
  const updateShare = useEffectAction<ShareAccess, ShareResponse, ApiError>((nextAccess) =>
    api.updateShare(documentId, nextAccess, expectedRevision),
  );

  useEffect(() => {
    setSelectedAccess(access);
  }, [access]);

  const dismiss = (): void => {
    if (!updateShare.state.pending) setOpen(false);
  };

  return (
    <>
      <Button variant="toolbar" data-share="" onClick={() => setOpen(true)}>
        Share
      </Button>
      <ModalDialog
        aria-labelledby="sharing-dialog-title"
        className="sharing-dialog"
        onDismiss={dismiss}
        open={open}
        preventDismiss={updateShare.state.pending}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            updateShare.execute(selectedAccess, {
              onSuccess: (response) => {
                onUpdated(response);
                setOpen(false);
                if (response.capabilityUrl === undefined) {
                  showToast("Share access updated.", "success");
                  return;
                }
                browserRuntime.runFork(
                  Effect.tryPromise({
                    catch: () => undefined,
                    try: () => navigator.clipboard.writeText(response.capabilityUrl ?? ""),
                  }).pipe(Effect.ignore),
                );
                showToast("Capability URL copied. It will not be shown again.", "success");
              },
            });
          }}
        >
          <DialogHeader
            closeLabel="Close sharing settings"
            disabled={updateShare.state.pending}
            eyebrow="Capability access"
            onClose={dismiss}
            title="Share document"
            titleId="sharing-dialog-title"
          />
          <SelectField
            label="Anyone with the capability link can"
            onChange={(event) => {
              const value = event.currentTarget.value;
              if (isShareAccess(value)) setSelectedAccess(value);
            }}
            value={selectedAccess}
          >
            <option value="disabled">Not access this document</option>
            <option value="view">View</option>
            <option value="comment">View and comment</option>
            <option value="edit">View, comment, and edit</option>
          </SelectField>
          <p className="dialog-note">
            Changing access revokes existing capability links. A new link is copied when sharing is
            enabled.
          </p>
          <Button disabled={updateShare.state.pending} type="submit" variant="primary">
            {updateShare.state.pending ? "Updating…" : "Update access"}
          </Button>
          <FormError>{updateShare.state.error?.message}</FormError>
        </form>
      </ModalDialog>
    </>
  );
}

function isShareAccess(value: string): value is ShareAccess {
  return value === "disabled" || value === "view" || value === "comment" || value === "edit";
}
