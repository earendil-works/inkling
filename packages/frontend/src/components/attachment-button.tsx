import type { AttachmentMetadataDto } from "@earendil-works/inkling-protocol";

import type { ApiClientService, ApiError } from "../api.ts";
import { useAppContext } from "../app-context.tsx";
import { useEffectAction } from "../effect-hooks.ts";

const acceptedTypes = "image/png,image/jpeg,image/gif,image/webp,application/pdf,text/plain";

export interface AttachmentButtonProps {
  readonly api: ApiClientService;
  readonly disabled: boolean;
  readonly documentId: string;
  readonly onUploaded: (attachment: AttachmentMetadataDto) => void;
}

export function AttachmentButton({
  api,
  disabled,
  documentId,
  onUploaded,
}: AttachmentButtonProps): React.JSX.Element {
  const { showToast } = useAppContext();
  const upload = useEffectAction<File, AttachmentMetadataDto, ApiError>((file) =>
    api.uploadAttachment(documentId, file),
  );

  return (
    <label className="toolbar-button attachment-button">
      {upload.state.pending ? "Uploading…" : "Attach"}
      <input
        accept={acceptedTypes}
        data-attachment=""
        disabled={disabled || upload.state.pending}
        onChange={(event) => {
          const input = event.currentTarget;
          const file = input.files?.[0];
          if (file === undefined) return;
          upload.execute(file, {
            onFailure: (error) => {
              input.value = "";
              showToast(error.message, "error");
            },
            onSuccess: (attachment) => {
              input.value = "";
              onUploaded(attachment);
              showToast("Attachment uploaded and linked.", "success");
            },
          });
        }}
        type="file"
      />
    </label>
  );
}
