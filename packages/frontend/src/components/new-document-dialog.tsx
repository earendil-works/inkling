import { useState } from "react";

import { identifierTag } from "@earendil-works/inkling-core";
import type { CreateDocumentRequest, DocumentResponse } from "@earendil-works/inkling-protocol";

import type { ApiClientService, ApiError } from "../api.ts";
import { useAppContext } from "../app-context.tsx";
import { useEffectAction } from "../effect-hooks.ts";
import { documentHref, randomId } from "../ui.ts";
import { Button } from "./button.tsx";
import { CheckboxField } from "./checkbox-field.tsx";
import { DialogHeader } from "./dialog-header.tsx";
import { FormError } from "./form-error.tsx";
import { ModalDialog } from "./modal-dialog.tsx";
import styles from "./new-document-dialog.module.css";
import { TextField } from "./text-field.tsx";

export interface NewDocumentDialogProps {
  readonly api: ApiClientService;
  readonly onDismiss: () => void;
  readonly open: boolean;
}

export function NewDocumentDialog({
  api,
  onDismiss,
  open,
}: NewDocumentDialogProps): React.JSX.Element {
  const { navigate } = useAppContext();
  const [title, setTitle] = useState("");
  const [allocateRfc, setAllocateRfc] = useState(false);
  const createDocument = useEffectAction<CreateDocumentRequest, DocumentResponse, ApiError>(
    (input) => api.createDocument(input),
  );

  const submit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    createDocument.execute(
      {
        allocateRfc,
        body: "",
        creationKey: randomId(identifierTag.request),
        title,
      },
      {
        onSuccess: (document) => {
          onDismiss();
          navigate(
            documentHref(document.metadata.id, document.metadata.rfcNumber, false, "edit", ""),
          );
        },
      },
    );
  };

  return (
    <ModalDialog
      aria-labelledby="new-document-dialog-title"
      className={styles["dialog"]}
      data-new-dialog=""
      onDismiss={onDismiss}
      open={open}
      preventDismiss={createDocument.state.pending}
    >
      <form data-new-form="" onSubmit={submit}>
        <DialogHeader
          closeLabel="Close new document dialog"
          disabled={createDocument.state.pending}
          eyebrow="Begin a working head"
          onClose={onDismiss}
          title="New note or RFC"
          titleId="new-document-dialog-title"
        />
        <TextField
          autoFocus
          label="Title"
          maxLength={300}
          name="title"
          onChange={(event) => setTitle(event.currentTarget.value)}
          required
          value={title}
        />
        <CheckboxField
          checked={allocateRfc}
          label="Create as an RFC and allocate a number"
          name="rfc"
          onChange={(event) => setAllocateRfc(event.currentTarget.checked)}
        />
        <Button disabled={createDocument.state.pending} type="submit" variant="primary">
          {createDocument.state.pending ? "Creating…" : allocateRfc ? "Create RFC" : "Create note"}
        </Button>
        <FormError data-new-error="">{createDocument.state.error?.message}</FormError>
      </form>
    </ModalDialog>
  );
}
