import type {
  AttachmentMetadataDto,
  DocumentMetadataDto,
  ShareResponse,
} from "@earendil-works/jot-protocol";

import type { ApiClientService } from "../api.ts";
import { documentHref } from "../ui.ts";
import { AllocateRfcButton } from "./allocate-rfc-button.tsx";
import { AttachmentButton } from "./attachment-button.tsx";
import { ButtonLink } from "./button-link.tsx";
import { Button } from "./button.tsx";
import { EditableDocumentTitle } from "./editable-document-title.tsx";
import { PublishButton } from "./publish-button.tsx";
import { SharingControl } from "./sharing-control.tsx";

export interface EditorToolbarProps {
  readonly api: ApiClientService;
  readonly canEdit: boolean;
  readonly canEditMetadata: boolean;
  readonly metadata: DocumentMetadataDto;
  readonly onAttachment: (attachment: AttachmentMetadataDto) => void;
  readonly onMetadataChanged: (metadata: DocumentMetadataDto) => void;
  readonly onMetadataUpdate: (input: Readonly<Record<string, unknown>>) => void;
  readonly onOpenComments: () => void;
  readonly onSharingChanged: (response: ShareResponse) => void;
  readonly onTogglePreview: () => void;
  readonly openCommentCount: number;
  readonly previewOpen: boolean;
  readonly publicationMetadata: DocumentMetadataDto;
  readonly shared: boolean;
}

export function EditorToolbar({
  api,
  canEdit,
  canEditMetadata,
  metadata,
  onAttachment,
  onMetadataChanged,
  onMetadataUpdate,
  onOpenComments,
  onSharingChanged,
  onTogglePreview,
  openCommentCount,
  previewOpen,
  publicationMetadata,
  shared,
}: EditorToolbarProps): React.JSX.Element {
  return (
    <section className="document-bar">
      <EditableDocumentTitle
        canEdit={canEditMetadata}
        onCommit={(title) => onMetadataUpdate({ title })}
        rfcNumber={metadata.rfcNumber}
        title={metadata.title}
      />
      <div className="document-actions">
        <ButtonLink
          className="document-mode-link"
          href={documentHref(metadata.id, shared, "read")}
          variant="toolbar"
        >
          Read
        </ButtonLink>
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
          <>
            <SharingControl
              access={metadata.sharing.access}
              api={api}
              documentId={metadata.id}
              expectedRevision={metadata.headRevision}
              onUpdated={onSharingChanged}
            />
            <PublishButton
              api={api}
              metadata={publicationMetadata}
              onPublished={onMetadataChanged}
              published={metadata.publishedRevision !== undefined}
            />
          </>
        )}
      </div>
    </section>
  );
}
