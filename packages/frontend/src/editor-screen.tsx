import { useEffect, useRef, useState } from "react";

import type { DocumentMetadataDto, DocumentResponse } from "@earendil-works/jot-protocol";

import type { ApiClientService, ApiError } from "./api.ts";
import { useAppContext } from "./app-context.tsx";
import type { ConnectionState } from "./collaboration.ts";
import { EditorComments } from "./components/editor-comments.tsx";
import type { EditorCommentsHandle } from "./components/editor-comments.tsx";
import { EditorToolbar } from "./components/editor-toolbar.tsx";
import { connectionLabel, EditorWorkbench } from "./components/editor-workbench.tsx";
import { GuestIdentityDialog } from "./components/guest-identity-dialog.tsx";
import { useEffectAction } from "./effect-hooks.ts";
import { useRenderedMarkdown } from "./markdown.tsx";
import { documentHref, storedGuestName, storeGuestName } from "./ui.ts";
import { useEditorSession } from "./use-editor-session.ts";

export interface EditorScreenProps {
  readonly api: ApiClientService;
  readonly capabilityToken: string | undefined;
  readonly document: DocumentResponse;
  readonly shared: boolean;
}

export function EditorScreen({
  api,
  capabilityToken,
  document: initial,
  shared,
}: EditorScreenProps): React.JSX.Element {
  const { navigate, setParticipants, setStatus, showToast } = useAppContext();
  const previewRef = useRef<HTMLElement>(null);
  const editorCommentsRef = useRef<EditorCommentsHandle>(null);
  const [metadata, setMetadata] = useState(initial.metadata);
  const [comments, setComments] = useState(initial.comments);
  const [displayName, setDisplayName] = useState<string | undefined>(() =>
    shared ? storedGuestName() : "Owner",
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
    initialBody: initial.body,
    initiallyEditable,
    onComments: setComments,
    onError: (message) => showToast(message, "error"),
    onMetadata: setMetadata,
    onParticipants: setParticipants,
    onPermissions: (actions) => {
      setPermissions(actions);
      if (!actions.includes("edit-body")) setPreviewOpen(false);
    },
    onState: (state) => {
      setConnectionState(state);
      setStatus({ label: connectionLabel(state), state: state === "ready" ? "ready" : state });
    },
    shared,
  });
  const canEdit = permissions?.includes("edit-body") ?? initiallyEditable;
  const canComment = permissions?.includes("comment") ?? false;
  const canEditMetadata = permissions?.includes("edit-metadata") ?? !shared;
  const rendered = useRenderedMarkdown(body, true);

  useEffect(() => {
    if (rendered.error !== undefined) showToast(`Preview failed: ${rendered.error}`, "error");
  }, [rendered.error, showToast]);

  const metadataAction = useEffectAction<
    Readonly<Record<string, unknown>>,
    DocumentMetadataDto,
    ApiError
  >((input) => api.updateMetadata(metadata.id, input));
  const updateMetadata = (input: Readonly<Record<string, unknown>>): void => {
    metadataAction.execute(
      { expectedRevision: metadata.headRevision, ...input },
      { onFailure: (error) => showToast(error.message, "error"), onSuccess: setMetadata },
    );
  };
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
        onMetadataUpdate={updateMetadata}
        onOpenComments={() => editorCommentsRef.current?.openControls()}
        onSharingChanged={(response) =>
          setMetadata((current) => ({
            ...current,
            headRevision: current.headRevision + 1,
            sharing: response.policy,
          }))
        }
        onTogglePreview={() => setPreviewOpen((open) => !open)}
        openCommentCount={openCount}
        previewOpen={previewOpen}
        shared={shared}
      />
      <EditorWorkbench
        connectionState={connectionState}
        editorHostRef={editorHostRef}
        onClosePreview={() => setPreviewOpen(false)}
        onPreviewRendered={() => setPreviewRevision((revision) => revision + 1)}
        onPreviewSelection={(range) => editorCommentsRef.current?.setPreviewSelection(range)}
        previewHtml={rendered.html}
        previewRef={previewRef}
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
          onCancel={() => navigate(documentHref(metadata.id, true, "read"))}
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
