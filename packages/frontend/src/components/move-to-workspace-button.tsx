import { useState } from "react";
import { Effect } from "effect";

import { GroupsIcon } from "@earendil-works/elanor-icons-react";
import { Button } from "@earendil-works/elanor-react";
import type { DocumentMetadataDto } from "@earendil-works/inkling-protocol";

import type { ApiClientService, ApiError } from "../api.ts";
import type { CollaborationClientError } from "../collaboration.ts";
import { useAppContext } from "../app-context.tsx";
import { useEffectAction } from "../effect-hooks.ts";
import { ConfirmationDialog } from "./confirmation-dialog.tsx";

export interface MoveToWorkspaceButtonProps {
  readonly api: ApiClientService;
  /** Saves pending edits so the move applies to the latest revision. */
  readonly beforeMove: () => Effect.Effect<void, CollaborationClientError>;
  readonly documentId: string;
  readonly onMoved: (metadata: DocumentMetadataDto) => void;
}

/** Makes a personal document visible to the whole workspace, after confirmation. */
export function MoveToWorkspaceButton({
  api,
  beforeMove,
  documentId,
  onMoved,
}: MoveToWorkspaceButtonProps): React.JSX.Element {
  const { showToast } = useAppContext();
  const [open, setOpen] = useState(false);
  // The revision moves with every keystroke, so the move reads it after saving.
  const move = useEffectAction<undefined, DocumentMetadataDto, ApiError | CollaborationClientError>(
    () =>
      beforeMove().pipe(
        Effect.zipRight(api.readDocument(documentId)),
        Effect.flatMap((current) => api.moveToWorkspace(documentId, current.metadata.headRevision)),
      ),
  );

  return (
    <>
      <Button
        data-move-to-workspace=""
        hierarchy="tertiary"
        iconStart={<GroupsIcon />}
        onClick={() => setOpen(true)}
      >
        Move to workspace
      </Button>
      <ConfirmationDialog
        confirmLabel="Move to workspace"
        description="Everyone in the workspace will be able to find, read, and edit this document. Documents cannot be made personal again."
        onCancel={() => setOpen(false)}
        onConfirm={() =>
          move.execute(undefined, {
            onFailure: (error) => {
              setOpen(false);
              showToast(error.message, "error");
            },
            onSuccess: (metadata) => {
              setOpen(false);
              onMoved(metadata);
              showToast("Document moved to the workspace.", "success");
            },
          })
        }
        open={open}
        pending={move.state.pending}
        title="Move this document to the workspace?"
      />
    </>
  );
}
