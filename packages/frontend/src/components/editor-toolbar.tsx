import { ChatBubbleIcon, DeleteIcon, VisibilityIcon } from "@earendil-works/elanor-icons-react";
import { Button } from "@earendil-works/elanor-react";
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
import styles from "./editor.module.css";
import { HistoryControl } from "./history-control.tsx";
import type { HistoryControlProps } from "./history-control.tsx";
import { AudienceButton } from "./audience-button.tsx";
import { PublishButton } from "./publish-button.tsx";
import type { PublishButtonProps } from "./publish-button.tsx";
import { SharingControl } from "./sharing-control.tsx";

export interface EditorToolbarProps {
  readonly api: ApiClientService;
  readonly canDelete: boolean;
  readonly canEdit: boolean;
  readonly canEditMetadata: boolean;
  readonly canMakePersonal: boolean;
  readonly canManageSharing: boolean;
  readonly canMoveToWorkspace: boolean;
  readonly commentsButtonRef?: React.Ref<HTMLButtonElement> | undefined;
  readonly metadata: DocumentMetadataDto;
  readonly onAttachment: (attachment: AttachmentMetadataDto) => void;
  readonly onDelete: () => void;
  readonly onHistoryPreview: HistoryControlProps["onPreview"];
  readonly onHistoryRestored: (document: DocumentResponse) => void;
  readonly onMetadataChanged: (metadata: DocumentMetadataDto) => void;
  readonly onOpenComments: () => void;
  readonly onSharingChanged: (response: ShareLinksResponse) => void;
  readonly onTogglePreview: () => void;
  readonly openCommentCount: number;
  readonly previewOpen: boolean;
  readonly publishBlockedLabel?: string | undefined;
  readonly publicationMetadata: DocumentMetadataDto;
  /** Saves pending edits before history opens or a revision is published. */
  readonly saveChanges: HistoryControlProps["beforeOpen"] & PublishButtonProps["beforePublish"];
  readonly shared: boolean;
}

export function EditorToolbar({
  api,
  canDelete,
  canEdit,
  canEditMetadata,
  canMakePersonal,
  canManageSharing,
  canMoveToWorkspace,
  commentsButtonRef,
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
  publishBlockedLabel,
  publicationMetadata,
  saveChanges,
  shared,
}: EditorToolbarProps): React.JSX.Element {
  const trashed = metadata.deletedAt !== undefined;
  // Personal documents move to the workspace before they are published, and
  // only their owner shares them.
  const personal = metadata.personalOwner !== undefined;
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
          data-preview-toggle=""
          hierarchy="secondary"
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
        <Button
          data-open-comments=""
          hierarchy="tertiary"
          iconStart={<ChatBubbleIcon />}
          onClick={onOpenComments}
          ref={commentsButtonRef}
        >
          Comments
          <span className={styles["commentCount"]} data-comment-count="">
            {openCommentCount}
          </span>
        </Button>
        {shared || trashed ? null : (
          <HistoryControl
            api={api}
            beforeOpen={saveChanges}
            canRestore={canEdit}
            currentRevision={metadata.headRevision}
            documentId={metadata.id}
            onPreview={onHistoryPreview}
            onRestored={onHistoryRestored}
          />
        )}
        <AllocateRfcButton
          api={api}
          canAllocate={canEditMetadata && !personal}
          metadata={metadata}
          onAllocated={onMetadataChanged}
        />
        {canMoveToWorkspace && personal && !trashed && !shared ? (
          <AudienceButton
            api={api}
            beforeChange={saveChanges}
            destination="workspace"
            documentId={metadata.id}
            onChanged={onMetadataChanged}
          />
        ) : null}
        {canMakePersonal &&
        !personal &&
        !trashed &&
        !shared &&
        // Permissions arrive with the connection; publishing or numbering since ends eligibility.
        metadata.publishedRevision === undefined &&
        metadata.rfcNumber === undefined ? (
          <AudienceButton
            api={api}
            beforeChange={saveChanges}
            destination="personal"
            documentId={metadata.id}
            onChanged={onMetadataChanged}
          />
        ) : null}
        {shared || trashed || (personal && !canManageSharing) ? null : (
          <SharingControl
            access={metadata.sharing.access}
            api={api}
            documentId={metadata.id}
            onUpdated={onSharingChanged}
            personal={
              personal
                ? { onPeopleChanged: onMetadataChanged, people: metadata.sharedWith ?? [] }
                : undefined
            }
          />
        )}
        <ButtonLink
          hierarchy="tertiary"
          iconStart={<VisibilityIcon />}
          href={documentHref(metadata.id, metadata.rfcNumber, shared, "read")}
        >
          View
        </ButtonLink>
        {shared || trashed || personal ? null : (
          <PublishButton
            api={api}
            beforePublish={saveChanges}
            blockedLabel={publishBlockedLabel}
            metadata={publicationMetadata}
            onPublished={onMetadataChanged}
            published={metadata.publishedRevision !== undefined}
          />
        )}
        {canDelete && !trashed ? (
          <Button
            data-delete-document=""
            hierarchy="tertiary"
            iconStart={<DeleteIcon />}
            onClick={onDelete}
            semantic="negative"
          >
            Trash
          </Button>
        ) : null}
      </div>
    </section>
  );
}
