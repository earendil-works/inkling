import { useState } from "react";
import { Effect } from "effect";

import { GroupsIcon, LockIcon } from "@earendil-works/elanor-icons-react";
import { Button } from "@earendil-works/elanor-react";
import type { DocumentMetadataDto } from "@earendil-works/inkling-protocol";

import type { ApiClientService, ApiError } from "../api.ts";
import type { CollaborationClientError } from "../collaboration.ts";
import { useAppContext } from "../app-context.tsx";
import { useEffectAction } from "../effect-hooks.ts";
import { ConfirmationDialog } from "./confirmation-dialog.tsx";

export interface AudienceButtonProps {
  readonly api: ApiClientService;
  /** Saves pending edits so the change applies to the latest revision. */
  readonly beforeChange: () => Effect.Effect<void, CollaborationClientError>;
  readonly documentId: string;
  /** Where the document goes: into the workspace, or into its owner's personal space. */
  readonly destination: "personal" | "workspace";
  readonly onChanged: (metadata: DocumentMetadataDto) => void;
}

const destinations = {
  personal: {
    confirmLabel: "Make personal",
    description:
      "Only you and the people who edited or commented on it will be able to find and open it; you can change who in Share. Anyone who already read it may have kept a copy. Once a document is published, it can no longer become personal.",
    icon: <LockIcon />,
    label: "Make personal",
    success: "Document is now personal.",
    title: "Make this document personal?",
  },
  workspace: {
    confirmLabel: "Move to workspace",
    description:
      "Everyone in the workspace will be able to find, read, and edit this document. It can become personal again until it is first published.",
    icon: <GroupsIcon />,
    label: "Move to workspace",
    success: "Document moved to the workspace.",
    title: "Move this document to the workspace?",
  },
} as const;

/** Moves a document between the workspace and its owner's personal space, after confirmation. */
export function AudienceButton({
  api,
  beforeChange,
  documentId,
  destination,
  onChanged,
}: AudienceButtonProps): React.JSX.Element {
  const { showToast } = useAppContext();
  const [open, setOpen] = useState(false);
  const copy = destinations[destination];
  // The revision moves with every keystroke, so the change reads it after saving.
  const change = useEffectAction<
    undefined,
    DocumentMetadataDto,
    ApiError | CollaborationClientError
  >(() =>
    beforeChange().pipe(
      Effect.zipRight(api.readDocument(documentId)),
      Effect.flatMap((current) =>
        destination === "workspace"
          ? api.moveToWorkspace(documentId, current.metadata.headRevision)
          : api.makePersonal(documentId, current.metadata.headRevision),
      ),
    ),
  );

  return (
    <>
      <Button
        data-make-personal={destination === "personal" ? "" : undefined}
        data-move-to-workspace={destination === "workspace" ? "" : undefined}
        hierarchy="tertiary"
        iconStart={copy.icon}
        onClick={() => setOpen(true)}
      >
        {copy.label}
      </Button>
      <ConfirmationDialog
        confirmLabel={copy.confirmLabel}
        description={copy.description}
        onCancel={() => setOpen(false)}
        onConfirm={() =>
          change.execute(undefined, {
            onFailure: (error) => {
              setOpen(false);
              showToast(error.message, "error");
            },
            onSuccess: (metadata) => {
              setOpen(false);
              onChanged(metadata);
              showToast(copy.success, "success");
            },
          })
        }
        open={open}
        pending={change.state.pending}
        title={copy.title}
      />
    </>
  );
}
