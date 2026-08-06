import { useState } from "react";

import type { CreateDocumentRequest, DocumentResponse } from "@earendil-works/jot-protocol";

import type { ApiClientService, ApiError } from "../api.ts";
import { useAppContext } from "../app-context.tsx";
import { useEffectAction } from "../effect-hooks.ts";
import { randomId } from "../ui.ts";
import { Button } from "./button.tsx";
import { CheckboxField } from "./checkbox-field.tsx";
import { DialogHeader } from "./dialog-header.tsx";
import { FormError } from "./form-error.tsx";
import { ModalDialog } from "./modal-dialog.tsx";
import { TextareaField } from "./textarea-field.tsx";
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
  const [body, setBody] = useState("");
  const [allocateRfc, setAllocateRfc] = useState(false);
  const createDocument = useEffectAction<CreateDocumentRequest, DocumentResponse, ApiError>(
    (input) => api.createDocument(input),
  );

  const submit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    createDocument.execute(
      {
        allocateRfc,
        body,
        creationKey: randomId("request"),
        title,
      },
      {
        onSuccess: (document) => {
          onDismiss();
          navigate(`/documents/${encodeURIComponent(document.metadata.id)}`);
        },
      },
    );
  };

  return (
    <ModalDialog
      aria-labelledby="new-document-dialog-title"
      className="new-document"
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
          title="New document"
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
          label="Allocate an RFC number"
          name="rfc"
          onChange={(event) => setAllocateRfc(event.currentTarget.checked)}
        />
        <TextareaField
          label="Opening Markdown"
          name="body"
          onChange={(event) => setBody(event.currentTarget.value)}
          placeholder={"# Context\n\nStart with the decision…"}
          rows={9}
          value={body}
        />
        <Button disabled={createDocument.state.pending} type="submit" variant="primary">
          {createDocument.state.pending ? "Creating…" : "Create document"}
        </Button>
        <FormError data-new-error="">{createDocument.state.error?.message}</FormError>
      </form>
    </ModalDialog>
  );
}
