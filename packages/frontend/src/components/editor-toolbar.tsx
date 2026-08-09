import type {
  AttachmentMetadataDto,
  DocumentMetadataDto,
  ShareLinksResponse,
} from "@earendil-works/inkling-protocol";

import type { ApiClientService } from "../api.ts";
import { documentHref } from "../ui.ts";
import { AllocateRfcButton } from "./allocate-rfc-button.tsx";
import { AttachmentButton } from "./attachment-button.tsx";
import { ButtonLink } from "./button-link.tsx";
import { Button } from "./button.tsx";
import { PublishButton } from "./publish-button.tsx";
import type { PublishButtonProps } from "./publish-button.tsx";
import { SharingControl } from "./sharing-control.tsx";

export interface EditorToolbarProps {
  readonly api: ApiClientService;
  readonly beforePublish: PublishButtonProps["beforePublish"];
  readonly canEdit: boolean;
  readonly canEditMetadata: boolean;
  readonly metadata: DocumentMetadataDto;
  readonly onAttachment: (attachment: AttachmentMetadataDto) => void;
  readonly onMetadataChanged: (metadata: DocumentMetadataDto) => void;
  readonly onOpenComments: () => void;
  readonly onSharingChanged: (response: ShareLinksResponse) => void;
  readonly onTogglePreview: () => void;
  readonly openCommentCount: number;
  readonly previewOpen: boolean;
  readonly publishDisabled: boolean;
  readonly publishDisabledLabel?: string | undefined;
  readonly publicationMetadata: DocumentMetadataDto;
  readonly shared: boolean;
}

export function EditorToolbar({
  api,
  beforePublish,
  canEdit,
  canEditMetadata,
  metadata,
  onAttachment,
  onMetadataChanged,
  onOpenComments,
  onSharingChanged,
  onTogglePreview,
  openCommentCount,
  previewOpen,
  publishDisabled,
  publishDisabledLabel,
  publicationMetadata,
  shared,
}: EditorToolbarProps): React.JSX.Element {
  return (
    <section className="document-bar">
      <div className="document-actions">
        <Button
          aria-pressed={previewOpen}
          className="preview-toggle"
          variant="toolbar"
          data-preview-toggle=""
          onClick={onTogglePreview}
        >
          Preview
        </Button>
        <AttachmentButton
          api={api}
          disabled={!canEdit}
          documentId={metadata.id}
          onUploaded={onAttachment}
        />
        <Button variant="toolbar" onClick={onOpenComments}>
          Comments{" "}
          <span className="comment-count" data-comment-count="">
            {openCommentCount}
          </span>
        </Button>
        <AllocateRfcButton
          api={api}
          canAllocate={canEditMetadata}
          metadata={metadata}
          onAllocated={onMetadataChanged}
        />
        {shared ? null : (
          <SharingControl
            access={metadata.sharing.access}
            api={api}
            documentId={metadata.id}
            onUpdated={onSharingChanged}
          />
        )}
        <ButtonLink
          className="document-mode-link"
          href={documentHref(metadata.id, metadata.rfcNumber, shared, "read")}
          variant="toolbar"
        >
          View
        </ButtonLink>
        {shared ? null : (
          <PublishButton
            api={api}
            beforePublish={beforePublish}
            disabled={publishDisabled}
            disabledLabel={publishDisabledLabel}
            metadata={publicationMetadata}
            onPublished={onMetadataChanged}
            published={metadata.publishedRevision !== undefined}
          />
        )}
      </div>
    </section>
  );
}
