import type { DocumentMetadataDto } from "@earendil-works/jot-protocol";

import type { ApiClientService, ApiError } from "../api.ts";
import { useAppContext } from "../app-context.tsx";
import { useEffectAction } from "../effect-hooks.ts";
import { Button } from "./button.tsx";

export interface PublishButtonProps {
  readonly api: ApiClientService;
  readonly documentId: string;
  readonly onPublished: (metadata: DocumentMetadataDto) => void;
  readonly published: boolean;
}

export function PublishButton({
  api,
  documentId,
  onPublished,
  published,
}: PublishButtonProps): React.JSX.Element {
  const { showToast } = useAppContext();
  const publish = useEffectAction<void, DocumentMetadataDto, ApiError>(() =>
    api.publish(documentId),
  );

  return (
    <Button
      size="small"
      variant="primary"
      data-publish=""
      disabled={publish.state.pending}
      onClick={() =>
        publish.execute(undefined, {
          onFailure: (error) => showToast(error.message, "error"),
          onSuccess: (metadata) => {
            onPublished(metadata);
            showToast("Revision published.", "success");
          },
        })
      }
    >
      {publish.state.pending ? "Publishing…" : published ? "Republish" : "Publish"}
    </Button>
  );
}
