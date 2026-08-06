import { useEffect, useMemo, useRef, useState } from "react";
import { Effect, Fiber } from "effect";

import { createCommentAnchor, resolveCommentAnchor } from "@earendil-works/jot-collaboration";
import type {
  CommentStateDto,
  DocumentMetadataDto,
  DocumentResponse,
} from "@earendil-works/jot-protocol";

import { ApiError } from "./api.ts";
import type { ApiClientService } from "./api.ts";
import { useAppContext } from "./app-context.tsx";
import type { ConnectionState } from "./collaboration.ts";
import { CommentControls } from "./components/comment-controls.tsx";
import type { CommentControlsHandle } from "./components/comment-controls.tsx";
import { CommentComposer } from "./components/comment-composer.tsx";
import { CommentThreadCard } from "./components/comment-thread-card.tsx";
import { EditorToolbar } from "./components/editor-toolbar.tsx";
import { connectionLabel, EditorWorkbench } from "./components/editor-workbench.tsx";
import {
  renderPreviewCommentBubbles,
  renderPreviewCommentComposer,
  selectedPreviewSourceRange,
  updateEditorCommentDecorations,
} from "./comments.ts";
import type { PreviewSourceRange, ProjectedCommentThread } from "./comments.ts";
import { useEffectAction } from "./effect-hooks.ts";
import { browserRuntime } from "./effect-runtime.ts";
import { renderMermaid, useRenderedMarkdown } from "./markdown.tsx";
import { guestName } from "./ui.ts";
import { useEditorSession } from "./use-editor-session.ts";

type ComposerRequest =
  | { readonly kind: "create"; readonly quote: string; readonly range: PreviewSourceRange }
  | {
      readonly kind: "edit";
      readonly initialBody: string;
      readonly messageId: string;
      readonly threadId: string;
    }
  | {
      readonly kind: "reply";
      readonly parentId: string;
      readonly quote: string;
      readonly threadId: string;
    };

interface CommentOperation {
  readonly body?: string | undefined;
  readonly request:
    | ComposerRequest
    | { readonly kind: "delete-message"; readonly messageId: string; readonly threadId: string }
    | { readonly kind: "delete-thread"; readonly threadId: string }
    | { readonly kind: "resolve"; readonly resolved: boolean; readonly threadId: string };
}

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
  const { setParticipants, setStatus, showToast } = useAppContext();
  const previewRef = useRef<HTMLElement>(null);
  const commentControlsRef = useRef<CommentControlsHandle>(null);
  const [metadata, setMetadata] = useState(initial.metadata);
  const [comments, setComments] = useState(initial.comments);
  const [permissions, setPermissions] = useState<readonly string[]>();
  const [previewRevision, setPreviewRevision] = useState(0);
  const [projectedComments, setProjectedComments] = useState<readonly ProjectedCommentThread[]>([]);
  const [showResolved, setShowResolved] = useState(false);
  const [previewSelection, setPreviewSelection] = useState<PreviewSourceRange>();
  const [activeThreadId, setActiveThreadId] = useState<string>();
  const [activeSurface, setActiveSurface] = useState<"preview" | "source">("preview");
  const activeAnchorRef = useRef<HTMLElement | undefined>(undefined);
  const [activeAnchorRevision, setActiveAnchorRevision] = useState(0);
  const [composer, setComposer] = useState<ComposerRequest>();
  const [previewOpen, setPreviewOpen] = useState(false);
  const [connectionState, setConnectionState] = useState<ConnectionState>("connecting");
  const initiallyEditable = !shared || initial.metadata.sharing.access === "edit";
  const { body, editorHostRef, sessionRef, sessionRevision, yRevision } = useEditorSession({
    capabilityToken,
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
    const preview = previewRef.current;
    if (preview === null || rendered.html === "") return;
    preview.innerHTML = rendered.html;
    const fiber = browserRuntime.runFork(
      renderMermaid(preview).pipe(
        Effect.ensuring(Effect.sync(() => setPreviewRevision((revision) => revision + 1))),
      ),
    );
    return () => {
      browserRuntime.runFork(Fiber.interrupt(fiber));
    };
  }, [rendered.html]);

  useEffect(() => {
    if (rendered.error !== undefined) showToast(`Preview failed: ${rendered.error}`, "error");
  }, [rendered.error, showToast]);

  useEffect(() => {
    const session = sessionRef.current;
    if (session === undefined) return;
    let active = true;
    const fiber = browserRuntime.runFork(
      Effect.forEach(comments.threads, (thread) =>
        thread.anchor.orphaned
          ? Effect.succeed({
              end: thread.anchor.originalEnd,
              orphaned: true,
              start: thread.anchor.originalStart,
              thread,
            } satisfies ProjectedCommentThread)
          : resolveCommentAnchor(session.document, session.body, thread.anchor).pipe(
              Effect.map((resolved) => ({ ...resolved, thread }) satisfies ProjectedCommentThread),
              Effect.catchAll(() =>
                Effect.succeed({
                  end: thread.anchor.originalEnd,
                  orphaned: true,
                  start: thread.anchor.originalStart,
                  thread,
                } satisfies ProjectedCommentThread),
              ),
            ),
      ).pipe(
        Effect.tap((next) =>
          Effect.sync(() => {
            if (active) setProjectedComments(next);
          }),
        ),
      ),
    );
    return () => {
      active = false;
      browserRuntime.runFork(Fiber.interrupt(fiber));
    };
  }, [comments, sessionRevision, yRevision]);

  const visibleProjections = useMemo(
    () => projectedComments.filter((projection) => showResolved || !projection.thread.resolved),
    [projectedComments, showResolved],
  );
  useEffect(() => {
    const session = sessionRef.current;
    const preview = previewRef.current;
    if (session === undefined || preview === null) return;
    updateEditorCommentDecorations(session.editor, visibleProjections);
    renderPreviewCommentBubbles(preview, visibleProjections);
    renderPreviewCommentComposer(preview, previewSelection);
    if (activeThreadId !== undefined) {
      activeAnchorRef.current = [
        ...document.querySelectorAll<HTMLElement>("[data-comment-bubble]"),
      ].find(
        (element) =>
          element.dataset["commentBubble"] === activeThreadId &&
          element.dataset["commentSurface"] === activeSurface,
      );
      setActiveAnchorRevision((revision) => revision + 1);
    }
  }, [
    activeSurface,
    activeThreadId,
    previewRevision,
    previewSelection,
    sessionRevision,
    visibleProjections,
  ]);

  const commentAction = useEffectAction<CommentOperation, CommentStateDto, ApiError>(
    (operation) => {
      const request = operation.request;
      const commentBody = operation.body ?? "";
      switch (request.kind) {
        case "create": {
          const session = sessionRef.current;
          if (session === undefined) return Effect.fail(uiError("The editor is not ready."));
          return createCommentAnchor(session.body, request.range.start, request.range.end).pipe(
            Effect.mapError(() => uiError("The selected text is no longer available.")),
            Effect.flatMap((anchor) =>
              api.createThread(metadata.id, anchor, commentBody, shared ? guestName() : "Owner"),
            ),
          );
        }
        case "reply":
          return api.reply(
            metadata.id,
            request.threadId,
            request.parentId,
            commentBody,
            shared ? guestName() : "Owner",
          );
        case "edit":
          return api.editMessage(metadata.id, request.threadId, request.messageId, commentBody);
        case "delete-message":
          return api.deleteMessage(metadata.id, request.threadId, request.messageId);
        case "delete-thread":
          return api.deleteThread(metadata.id, request.threadId);
        case "resolve":
          return api.resolveThread(metadata.id, request.threadId, request.resolved);
      }
    },
  );

  const finishComment = (next: CommentStateDto): void => {
    setComments(next);
    setComposer(undefined);
    setPreviewSelection(undefined);
    document.getSelection()?.removeAllRanges();
    commentControlsRef.current?.close();
  };
  const submitComposer = (value: string): void => {
    if (composer === undefined) return;
    commentAction.execute(
      { body: value, request: composer },
      { onFailure: (error) => showToast(error.message, "error"), onSuccess: finishComment },
    );
  };
  const openCommentOnRange = (range: PreviewSourceRange): void => {
    const session = sessionRef.current;
    if (!canComment || session === undefined) return;
    if (range.start < 0 || range.end > session.body.length || range.end <= range.start) {
      showToast("Select text before opening a comment.", "error");
      return;
    }
    if (range.end - range.start > 20_000) {
      showToast("Select a smaller section to comment on.", "error");
      return;
    }
    setComposer({
      kind: "create",
      quote: session.body.toString().slice(range.start, range.end),
      range,
    });
  };
  const commentOnSelection = (): void => {
    const preview = previewRef.current;
    const session = sessionRef.current;
    if (preview === null || session === undefined) return;
    const previewRange = selectedPreviewSourceRange(preview);
    const selection = session.editor.state.selection.main;
    const sourceRange = selection.empty ? undefined : { end: selection.to, start: selection.from };
    const range = previewRange ?? previewSelection ?? sourceRange;
    if (range === undefined) {
      showToast("Select Markdown or rendered text before commenting.", "error");
      return;
    }
    openCommentOnRange(range);
  };

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
  const activeThread = comments.threads.find((thread) => thread.id === activeThreadId);

  const handleWorkbenchClick = (event: React.MouseEvent<HTMLElement>): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const inlineComposer = target.closest<HTMLElement>("[data-comment-composer]");
    if (inlineComposer !== null) {
      const start = Number(inlineComposer.dataset["sourceStart"]);
      const end = Number(inlineComposer.dataset["sourceEnd"]);
      if (Number.isSafeInteger(start) && Number.isSafeInteger(end)) {
        openCommentOnRange({ end, start });
      }
      return;
    }
    const bubble = target.closest<HTMLElement>("[data-comment-bubble]");
    const threadId = bubble?.dataset["commentBubble"];
    if (bubble === null || threadId === undefined) return;
    setActiveThreadId(threadId);
    setActiveSurface(bubble.dataset["commentSurface"] === "source" ? "source" : "preview");
    activeAnchorRef.current = bubble;
    setActiveAnchorRevision((revision) => revision + 1);
  };

  const openCount = comments.threads.filter((thread) => !thread.resolved).length;
  const orphaned = projectedComments.filter(
    (projection) => projection.orphaned && (showResolved || !projection.thread.resolved),
  );
  const layoutClass = `editor-layout ${canEdit ? "is-editable" : "is-reader"}${previewOpen ? " preview-open" : ""}`;

  return (
    <main className={layoutClass} id="app" onClick={handleWorkbenchClick} tabIndex={-1}>
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
        onOpenComments={() => commentControlsRef.current?.open()}
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
        onPreviewSelection={setPreviewSelection}
        previewRef={previewRef}
      />
      <CommentControls
        canComment={canComment}
        onCommentOnSelection={commentOnSelection}
        onShowResolvedChange={setShowResolved}
        orphaned={orphaned}
        ref={commentControlsRef}
        showResolved={showResolved}
      />
      <CommentThreadCard
        anchorRef={activeAnchorRef}
        anchorRevision={activeAnchorRevision}
        canManage={permissions?.includes("manage-comments") ?? false}
        onClose={() => setActiveThreadId(undefined)}
        onDeleteMessage={(messageId) => {
          if (activeThread === undefined || !window.confirm("Delete this comment message?")) return;
          commentAction.execute(
            { request: { kind: "delete-message", messageId, threadId: activeThread.id } },
            { onFailure: (error) => showToast(error.message, "error"), onSuccess: setComments },
          );
        }}
        onDeleteThread={() => {
          if (activeThread === undefined || !window.confirm("Delete this comment thread?")) return;
          commentAction.execute(
            { request: { kind: "delete-thread", threadId: activeThread.id } },
            {
              onFailure: (error) => showToast(error.message, "error"),
              onSuccess: (next) => {
                setComments(next);
                setActiveThreadId(undefined);
              },
            },
          );
        }}
        onEdit={(messageId, initialBody) => {
          if (activeThread !== undefined) {
            setComposer({ kind: "edit", initialBody, messageId, threadId: activeThread.id });
          }
        }}
        onReply={() => {
          const parent = activeThread?.messages.at(-1);
          if (activeThread !== undefined && parent !== undefined) {
            setComposer({
              kind: "reply",
              parentId: parent.id,
              quote: activeThread.anchor.quote,
              threadId: activeThread.id,
            });
          }
        }}
        onResolve={() => {
          if (activeThread === undefined) return;
          commentAction.execute(
            {
              request: {
                kind: "resolve",
                resolved: !activeThread.resolved,
                threadId: activeThread.id,
              },
            },
            { onFailure: (error) => showToast(error.message, "error"), onSuccess: setComments },
          );
        }}
        thread={activeThread}
      />
      {composer === undefined ? null : (
        <CommentComposer
          initialBody={composer.kind === "edit" ? composer.initialBody : undefined}
          onCancel={() => setComposer(undefined)}
          onSubmit={submitComposer}
          pending={commentAction.state.pending}
          quote={
            composer.kind === "create" || composer.kind === "reply" ? composer.quote : undefined
          }
          submitLabel={
            composer.kind === "edit" ? "Save" : composer.kind === "reply" ? "Reply" : "Comment"
          }
          title={
            composer.kind === "edit"
              ? "Edit comment"
              : composer.kind === "reply"
                ? "Reply to thread"
                : "Comment on selection"
          }
        />
      )}
    </main>
  );
}

function uiError(message: string): ApiError {
  return new ApiError({ code: "ui_error", message, retryable: false, status: 0 });
}
