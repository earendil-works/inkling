import { useEffect, useRef, useState } from "react";
import { Effect } from "effect";

import type { AuthenticationStatus, DocumentResponse } from "@earendil-works/inkling-protocol";

import type { ApiClientService } from "./api.ts";
import { useAppContext } from "./app-context.tsx";
import { CollaborationClientError } from "./collaboration.ts";
import type { ConnectionState } from "./collaboration.ts";
import { metadataWithFrontmatter } from "./components/document-metadata.ts";
import { EditorComments } from "./components/editor-comments.tsx";
import type { EditorCommentsHandle } from "./components/editor-comments.tsx";
import { EditorToolbar } from "./components/editor-toolbar.tsx";
import { connectionLabel, EditorWorkbench } from "./components/editor-workbench.tsx";
import { GuestIdentityDialog } from "./components/guest-identity-dialog.tsx";
import { useRenderedMarkdown } from "./markdown.tsx";
import { documentHref, storedGuestName, storeGuestName } from "./ui.ts";
import type { FrontmatterVocabulary } from "./frontmatter-completion.ts";
import { useEditorSession } from "./use-editor-session.ts";

export interface EditorScreenProps {
  readonly account?: NonNullable<AuthenticationStatus["principal"]> | undefined;
  readonly api: ApiClientService;
  readonly capabilityToken: string | undefined;
  readonly document: DocumentResponse;
  readonly frontmatterVocabulary: FrontmatterVocabulary;
  readonly shared: boolean;
}

export function EditorScreen({
  account,
  api,
  capabilityToken,
  document: initial,
  frontmatterVocabulary,
  shared,
}: EditorScreenProps): React.JSX.Element {
  const { navigate, setParticipants, setStatus, showToast } = useAppContext();
  const previewRef = useRef<HTMLElement>(null);
  const editorCommentsRef = useRef<EditorCommentsHandle>(null);
  const [metadata, setMetadata] = useState(initial.metadata);
  const [comments, setComments] = useState(initial.comments);
  const [displayName, setDisplayName] = useState<string | undefined>(() =>
    shared ? storedGuestName() : (account?.displayName ?? "Workspace member"),
  );
  const [permissions, setPermissions] = useState<readonly string[]>();
  const [previewRevision, setPreviewRevision] = useState(0);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [connectionState, setConnectionState] = useState<ConnectionState>("connecting");
  const initiallyEditable = !shared || initial.metadata.sharing.access === "edit";
  const { body, editorHostRef, sessionRef, sessionRevision, yRevision } = useEditorSession({
    capabilityToken,
    displayName,
    documentId: initial.metadata.id,
    frontmatterVocabulary,
    initialBody: initial.body,
    initiallyEditable,
    identityId: account?.id,
    onComments: setComments,
    onError: (message) => showToast(message, "error"),
    onMetadata: setMetadata,
    onParticipants: setParticipants,
    onPermissions: (actions) => {
      setPermissions(actions);
      if (!actions.includes("edit-body")) setPreviewOpen(false);
    },
    onRevision: (revision) =>
      setMetadata((current) =>
        revision > current.headRevision ? { ...current, headRevision: revision } : current,
      ),
    onState: (state) => {
      setConnectionState(state);
      setStatus({ label: connectionLabel(state), state });
    },
    shared,
  });
  useEffect(() => {
    setStatus({ label: connectionLabel("connecting"), state: "connecting" });
    return () => setStatus(undefined);
  }, [setStatus]);

  const canEdit = permissions?.includes("edit-body") ?? initiallyEditable;
  const canComment = permissions?.includes("comment") ?? false;
  const canEditMetadata = permissions?.includes("edit-metadata") ?? !shared;
  const rendered = useRenderedMarkdown(body, true);
  const publishDisabledLabel =
    connectionState === "connecting"
      ? "Connecting…"
      : connectionState === "disconnected"
        ? "Offline"
        : rendered.loading
          ? "Checking…"
          : rendered.error === undefined
            ? undefined
            : "Fix frontmatter";
  const saveBeforePublish = (): Effect.Effect<void, CollaborationClientError> =>
    sessionRef.current?.client?.flush ??
    Effect.fail(
      new CollaborationClientError({
        message: "Inkling cannot publish until the editor is connected.",
      }),
    );
  const previewMetadata = metadataWithFrontmatter(
    metadata,
    rendered.frontmatter,
    rendered.title,
    frontmatterVocabulary.people,
  );

  useEffect(() => {
    document.title = previewMetadata.title;
  }, [previewMetadata.title]);

  const openCount = comments.threads.filter((thread) => !thread.resolved).length;
  const layoutClass = `editor-layout ${canEdit ? "is-editable" : "is-reader"}${previewOpen ? " preview-open" : ""}`;

  return (
    <main
      className={layoutClass}
      id="app"
      onClick={(event) => editorCommentsRef.current?.handleWorkbenchClick(event.target)}
      tabIndex={-1}
    >
      <EditorToolbar
        api={api}
        beforePublish={saveBeforePublish}
        canEdit={canEdit}
        canEditMetadata={canEditMetadata}
        metadata={metadata}
        onAttachment={(attachment) => {
          const session = sessionRef.current;
          if (session === undefined) return;
          const selection = session.editor.state.selection.main;
          const label = attachment.filename.replaceAll("[", "").replaceAll("]", "");
          const insertedMarkdown = attachment.mediaType.startsWith("image/")
            ? `![${label}](${attachment.url})`
            : `[${label}](${attachment.url})`;
          session.editor.dispatch({
            changes: { from: selection.from, insert: insertedMarkdown, to: selection.to },
            selection: { anchor: selection.from + insertedMarkdown.length },
          });
        }}
        onMetadataChanged={setMetadata}
        onOpenComments={() => editorCommentsRef.current?.openControls()}
        onSharingChanged={(response) =>
          setMetadata((current) => ({
            ...current,
            headRevision: response.revision,
            sharing: response.policy,
          }))
        }
        onTogglePreview={() => setPreviewOpen((open) => !open)}
        openCommentCount={openCount}
        previewOpen={previewOpen}
        publishDisabled={publishDisabledLabel !== undefined}
        publishDisabledLabel={publishDisabledLabel}
        publicationMetadata={previewMetadata}
        shared={shared}
        title={previewMetadata.title}
      />
      <EditorWorkbench
        connectionState={connectionState}
        editor={sessionRef.current?.editor}
        editorHostRef={editorHostRef}
        onClosePreview={() => setPreviewOpen(false)}
        onPreviewRendered={() => setPreviewRevision((revision) => revision + 1)}
        onPreviewSelection={(range) => editorCommentsRef.current?.setPreviewSelection(range)}
        previewHeadings={rendered.headings}
        previewHtml={rendered.html}
        previewRef={previewRef}
        metadata={previewMetadata}
      />
      {displayName === undefined ? null : (
        <EditorComments
          api={api}
          authorDisplayName={displayName}
          canComment={canComment}
          canManage={permissions?.includes("manage-comments") ?? false}
          comments={comments}
          documentId={metadata.id}
          onCommentsChange={setComments}
          previewRef={previewRef}
          previewRevision={previewRevision}
          ref={editorCommentsRef}
          sessionRef={sessionRef}
          sessionRevision={sessionRevision}
          yRevision={yRevision}
        />
      )}
      {shared && displayName === undefined ? (
        <GuestIdentityDialog
          onCancel={() => navigate(documentHref(metadata.id, metadata.rfcNumber, true, "read"))}
          onIdentify={(name) => {
            storeGuestName(name);
            setDisplayName(name);
          }}
          open
        />
      ) : null}
    </main>
  );
}
