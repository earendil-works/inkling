import { useState } from "react";

import type { DocumentMetadataDto } from "@earendil-works/jot-protocol";

import type { ApiClientService, ApiError } from "../api.ts";
import { useAppContext } from "../app-context.tsx";
import { useEffectAction } from "../effect-hooks.ts";
import { Button } from "./button.tsx";
import { ConfirmationDialog } from "./confirmation-dialog.tsx";

export interface PublishButtonProps {
  readonly api: ApiClientService;
  readonly metadata: DocumentMetadataDto;
  readonly onPublished: (metadata: DocumentMetadataDto) => void;
  readonly published: boolean;
}

export function PublishButton({
  api,
  metadata,
  onPublished,
  published,
}: PublishButtonProps): React.JSX.Element {
  const { showToast } = useAppContext();
  const [confirmConfidential, setConfirmConfidential] = useState(false);
  const publish = useEffectAction<boolean, DocumentMetadataDto, ApiError>((confirm) =>
    api.publish(metadata.id, confirm),
  );
  const execute = (confirmConfidentialPublic: boolean): void => {
    publish.execute(confirmConfidentialPublic, {
      onFailure: (error) => showToast(error.message, "error"),
      onSuccess: (nextMetadata) => {
        onPublished(nextMetadata);
        showToast("Revision published.", "success");
      },
    });
  };

  return (
    <>
      <Button
        size="small"
        variant="primary"
        data-publish=""
        disabled={publish.state.pending}
        onClick={() => {
          if (metadata.visibility === "public" && metadata.sensitivity === "confidential") {
            setConfirmConfidential(true);
          } else {
            execute(false);
          }
        }}
      >
        {publish.state.pending ? "Publishing…" : published ? "Republish" : "Publish"}
      </Button>
      <ConfirmationDialog
        confirmLabel="Publish confidential revision"
        description="The frontmatter marks this revision as both public and confidential. Publishing will make its content and metadata publicly accessible."
        onCancel={() => setConfirmConfidential(false)}
        onConfirm={() => {
          setConfirmConfidential(false);
          execute(true);
        }}
        open={confirmConfidential}
        title="Publish confidential content?"
        tone="danger"
      />
    </>
  );
}
