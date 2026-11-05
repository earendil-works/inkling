import { useState } from "react";

import {
  Button,
  Checkbox,
  ControlAndLabel,
  Form,
  Input,
  Modal,
  SelectionControlAndLabel,
} from "@earendil-works/elanor-react";
import { identifierTag } from "@earendil-works/inkling-core";
import type { CreateDocumentRequest, DocumentResponse } from "@earendil-works/inkling-protocol";

import type { ApiClientService, ApiError } from "../api.ts";
import { useAppContext } from "../app-context.tsx";
import { useEffectAction } from "../effect-hooks.ts";
import { documentHref, randomId } from "../ui.ts";
import { Dialog } from "./dialog.tsx";
import styles from "./dialog.module.css";
import { FormError } from "./form-error.tsx";

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
  const [personal, setPersonal] = useState(false);
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
        personal,
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
    <Dialog
      attributes={{ "data-new-dialog": "" }}
      closeLabel="Close new document dialog"
      description="Notes suit meeting minutes and sketches; RFCs get a permanent number. Personal notes stay hidden from everyone else until you move them to the workspace."
      onClose={onDismiss}
      open={open}
      pending={createDocument.state.pending}
      title="New note or RFC"
    >
      <Form className={styles["form"]} data-new-form="" onSubmit={submit}>
        <ControlAndLabel label="Title">
          <Input
            autoFocus
            maxLength={300}
            name="title"
            onValueChange={setTitle}
            required
            value={title}
          />
        </ControlAndLabel>
        <SelectionControlAndLabel
          control={
            <Checkbox.Root
              checked={allocateRfc}
              name="rfc"
              onCheckedChange={(checked) => {
                setAllocateRfc(checked);
                if (checked) setPersonal(false);
              }}
            >
              <Checkbox.Indicator />
            </Checkbox.Root>
          }
        >
          Create as an RFC and allocate a number
        </SelectionControlAndLabel>
        <SelectionControlAndLabel
          control={
            <Checkbox.Root
              checked={personal}
              name="personal"
              onCheckedChange={(checked) => {
                setPersonal(checked);
                if (checked) setAllocateRfc(false);
              }}
            >
              <Checkbox.Indicator />
            </Checkbox.Root>
          }
        >
          Keep it personal so only you can see it
        </SelectionControlAndLabel>
        <FormError data-new-error="">{createDocument.state.error?.message}</FormError>
        <Modal.Actions>
          <Button pending={createDocument.state.pending} type="submit">
            {allocateRfc ? "Create RFC" : personal ? "Create personal note" : "Create note"}
          </Button>
        </Modal.Actions>
      </Form>
    </Dialog>
  );
}
