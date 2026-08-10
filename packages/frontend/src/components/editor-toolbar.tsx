import type {
  AttachmentMetadataDto,
  DocumentMetadataDto,
  DocumentResponse,
  ShareLinksResponse,
} from "@earendil-works/inkling-protocol";

import type { ApiClientService } from "../api.ts";
import { documentHref } from "../ui.ts";
import { AllocateRfcButton } from "./allocate-rfc-button.tsx";
import { AttachmentButton } from "./attachment-button.tsx";
import { ButtonLink } from "./button-link.tsx";
import { Button } from "./button.tsx";
import styles from "./editor.module.css";
import { HistoryControl } from "./history-control.tsx";
import type { HistoryControlProps } from "./history-control.tsx";
import { PublishButton } from "./publish-button.tsx";
import type { PublishButtonProps } from "./publish-button.tsx";
import { SharingControl } from "./sharing-control.tsx";

export interface EditorToolbarProps {
  readonly api: ApiClientService;
  readonly beforeHistory: HistoryControlProps["beforeOpen"];
  readonly beforePublish: PublishButtonProps["beforePublish"];
  readonly canDelete: boolean;
  readonly canEdit: boolean;
  readonly canEditMetadata: boolean;
  readonly metadata: DocumentMetadataDto;
  readonly onAttachment: (attachment: AttachmentMetadataDto) => void;
  readonly onDelete: () => void;
  readonly onHistoryPreview: (document: DocumentResponse | undefined) => void;
  readonly onHistoryRestored: (document: DocumentResponse) => void;
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
  beforeHistory,
  beforePublish,
  canDelete,
  canEdit,
  canEditMetadata,
  metadata,
  onAttachment,
  onDelete,
  onHistoryPreview,
  onHistoryRestored,
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
    <section
      className={`${styles["bar"]}${trashed ? ` ${styles["trashedBar"]}` : ""}`}
      data-editor-toolbar=""
    >
      {trashed ? (
        <p className={styles["trashIndicator"]} data-document-trashed="">
          <a href="/trash">In Trash</a>
          <span>Changes are still saved.</span>
        </p>
      ) : null}
      <div className={styles["actions"]} data-document-actions="">
        <Button
          aria-pressed={previewOpen}
          className={styles["previewToggle"]}
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
          <span className={styles["commentCount"]} data-comment-count="">
            {openCommentCount}
          </span>
        </Button>
        {shared || trashed ? null : (
          <HistoryControl
            api={api}
            beforeOpen={beforeHistory}
            canRestore={canEdit}
            currentRevision={metadata.headRevision}
            documentId={metadata.id}
            onPreview={onHistoryPreview}
            onRestored={onHistoryRestored}
          />
        )}
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
          className={styles["modeLink"]}
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
            className={styles["delete"]}
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
