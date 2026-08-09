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
  readonly canDelete: boolean;
  readonly canEdit: boolean;
  readonly canEditMetadata: boolean;
  readonly metadata: DocumentMetadataDto;
  readonly onAttachment: (attachment: AttachmentMetadataDto) => void;
  readonly onDelete: () => void;
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
  canDelete,
  canEdit,
  canEditMetadata,
  metadata,
  onAttachment,
  onDelete,
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
  const trashed = metadata.deletedAt !== undefined;
  return (
    <section className={`document-bar${trashed ? " is-trashed" : ""}`}>
      {trashed ? (
        <p className="document-trash-indicator" data-document-trashed="">
          <a href="/trash">In Trash</a>
          <span>Changes are still saved.</span>
        </p>
      ) : null}
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
        {shared || trashed ? null : (
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
        {shared || trashed ? null : (
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
        {canDelete && !trashed ? (
          <Button
            className="document-delete"
            data-delete-document=""
            onClick={onDelete}
            variant="toolbar"
          >
            Trash
          </Button>
        ) : null}
      </div>
    </section>
  );
}
