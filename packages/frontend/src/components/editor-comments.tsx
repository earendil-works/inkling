import { useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { Effect, Fiber } from "effect";

import { createCommentAnchor, resolveCommentAnchor } from "@earendil-works/inkling-collaboration";
import type { CommentStateDto } from "@earendil-works/inkling-protocol";

import { ApiError } from "../api.ts";
import type { ApiClientService } from "../api.ts";
import { useAppContext } from "../app-context.tsx";
import {
  renderPreviewCommentBubbles,
  renderPreviewCommentComposer,
  updateEditorCommentComposer,
  updateEditorCommentDecorations,
} from "../comments.ts";
import type { PreviewSourceRange, ProjectedCommentThread } from "../comments.ts";
import { useEffectAction } from "../effect-hooks.ts";
import { browserRuntime } from "../effect-runtime.ts";
import type { EditorSession } from "../use-editor-session.ts";
import { AnchoredPopover } from "./anchored-popover.tsx";
import { CommentComposer } from "./comment-composer.tsx";
import { CommentControls } from "./comment-controls.tsx";
import type { CommentControlsHandle } from "./comment-controls.tsx";
import { CommentThreadCard } from "./comment-thread-card.tsx";
import { ConfirmationDialog } from "./confirmation-dialog.tsx";
import styles from "./comments.module.css";

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

type PendingDeletion =
  | { readonly kind: "delete-message"; readonly messageId: string; readonly threadId: string }
  | { readonly kind: "delete-thread"; readonly threadId: string };

interface CommentOperation {
  readonly body?: string | undefined;
  readonly request:
    | ComposerRequest
    | { readonly kind: "delete-message"; readonly messageId: string; readonly threadId: string }
    | { readonly kind: "delete-thread"; readonly threadId: string }
    | { readonly kind: "resolve"; readonly resolved: boolean; readonly threadId: string };
}

export interface EditorCommentsHandle {
  readonly handleWorkbenchClick: (target: EventTarget) => void;
  readonly openControls: () => void;
  readonly setPreviewSelection: (range: PreviewSourceRange | undefined) => void;
}

export interface EditorCommentsProps {
  readonly api: ApiClientService;
  readonly authorDisplayName: string;
  readonly canComment: boolean;
  readonly canManage: boolean;
  readonly comments: CommentStateDto;
  readonly documentId: string;
  readonly onCommentsChange: (comments: CommentStateDto) => void;
  readonly previewRef: React.RefObject<HTMLElement | null>;
  readonly previewRevision: number;
  readonly ref?: React.Ref<EditorCommentsHandle> | undefined;
  readonly sessionRef: React.RefObject<EditorSession | undefined>;
  readonly sessionRevision: number;
  readonly yRevision: number;
}

export function EditorComments({
  api,
  authorDisplayName,
  canComment,
  canManage,
  comments,
  documentId,
  onCommentsChange,
  previewRef,
  previewRevision,
  ref,
  sessionRef,
  sessionRevision,
  yRevision,
}: EditorCommentsProps): React.JSX.Element {
  const { showToast } = useAppContext();
  const controlsRef = useRef<CommentControlsHandle>(null);
  const [projectedComments, setProjectedComments] = useState<readonly ProjectedCommentThread[]>([]);
  const [showResolved, setShowResolved] = useState(false);
  const [previewSelection, setPreviewSelection] = useState<PreviewSourceRange>();
  const [activeThreadId, setActiveThreadId] = useState<string>();
  const [activeSurface, setActiveSurface] = useState<"preview" | "source">("preview");
  const activeAnchorRef = useRef<HTMLElement | undefined>(undefined);
  const [activeAnchorRevision, setActiveAnchorRevision] = useState(0);
  const [composer, setComposer] = useState<ComposerRequest>();
  const [pendingDeletion, setPendingDeletion] = useState<PendingDeletion>();

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
  }, [comments, sessionRef, sessionRevision, yRevision]);

  const visibleProjections = useMemo(
    () => projectedComments.filter((projection) => showResolved || !projection.thread.resolved),
    [projectedComments, showResolved],
  );

  useEffect(() => {
    const session = sessionRef.current;
    const preview = previewRef.current;
    if (session === undefined || preview === null) return;
    updateEditorCommentDecorations(session.editor, visibleProjections, canComment);
    renderPreviewCommentBubbles(preview, visibleProjections);
    renderPreviewCommentComposer(preview, canComment ? previewSelection : undefined);
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
    canComment,
    previewRef,
    previewRevision,
    previewSelection,
    sessionRef,
    sessionRevision,
    visibleProjections,
  ]);

  useEffect(() => {
    const editor = sessionRef.current?.editor;
    if (editor === undefined) return;
    let frame: number | undefined;
    const revealComposer = (): void => {
      const selection = editor.state.selection.main;
      const range =
        canComment && !selection.empty ? { end: selection.to, start: selection.from } : undefined;
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => updateEditorCommentComposer(editor, range));
    };
    editor.dom.addEventListener("pointerup", revealComposer);
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      editor.dom.removeEventListener("pointerup", revealComposer);
    };
  }, [canComment, sessionRef, sessionRevision]);

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
              api.createThread(documentId, anchor, commentBody, authorDisplayName),
            ),
          );
        }
        case "reply":
          return api.reply(
            documentId,
            request.threadId,
            request.parentId,
            commentBody,
            authorDisplayName,
          );
        case "edit":
          return api.editMessage(documentId, request.threadId, request.messageId, commentBody);
        case "delete-message":
          return api.deleteMessage(documentId, request.threadId, request.messageId);
        case "delete-thread":
          return api.deleteThread(documentId, request.threadId);
        case "resolve":
          return api.resolveThread(documentId, request.threadId, request.resolved);
      }
    },
  );

  const finishComment = (next: CommentStateDto): void => {
    if (composer?.kind === "create") {
      const selection = sessionRef.current?.editor.state.selection.main;
      if (selection !== undefined && !selection.empty) {
        sessionRef.current?.editor.dispatch({ selection: { anchor: selection.to } });
      }
    }
    onCommentsChange(next);
    setComposer(undefined);
    setPreviewSelection(undefined);
    document.getSelection()?.removeAllRanges();
    controlsRef.current?.close();
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
  const handleWorkbenchClick = (target: EventTarget): void => {
    if (!(target instanceof Element)) return;
    const inlineComposer = target.closest<HTMLElement>("[data-comment-composer]");
    if (inlineComposer !== null) {
      const start = Number(inlineComposer.dataset["sourceStart"]);
      const end = Number(inlineComposer.dataset["sourceEnd"]);
      if (Number.isSafeInteger(start) && Number.isSafeInteger(end)) {
        activeAnchorRef.current = inlineComposer;
        setActiveAnchorRevision((revision) => revision + 1);
        setActiveThreadId(undefined);
        openCommentOnRange({ end, start });
      }
      return;
    }
    const bubble = target.closest<HTMLElement>("[data-comment-bubble]");
    const threadId = bubble?.dataset["commentBubble"];
    if (bubble === null || threadId === undefined) return;
    setComposer(undefined);
    setActiveThreadId(threadId);
    setActiveSurface(bubble.dataset["commentSurface"] === "source" ? "source" : "preview");
    activeAnchorRef.current = bubble;
    setActiveAnchorRevision((revision) => revision + 1);
  };

  useImperativeHandle(ref, () => ({
    handleWorkbenchClick,
    openControls: () => controlsRef.current?.open(),
    setPreviewSelection,
  }));

  const activeThread = comments.threads.find((thread) => thread.id === activeThreadId);
  const orphaned = projectedComments.filter(
    (projection) => projection.orphaned && (showResolved || !projection.thread.resolved),
  );
  const createRequest = composer?.kind === "create" ? composer : undefined;
  const editRequest = composer?.kind === "edit" ? composer : undefined;
  const replyRequest = composer?.kind === "reply" ? composer : undefined;
  const submitComment = (request: ComposerRequest, body: string): void => {
    commentAction.execute(
      { body, request },
      { onFailure: (error) => showToast(error.message, "error"), onSuccess: finishComment },
    );
  };

  return (
    <>
      <CommentControls
        onShowResolvedChange={setShowResolved}
        orphaned={orphaned}
        ref={controlsRef}
        showResolved={showResolved}
      />
      <AnchoredPopover
        anchorRef={activeAnchorRef}
        anchorRevision={activeAnchorRevision}
        aria-label="New comment"
        className={styles["composerPopover"]}
        data-comment-composer-popover=""
        open={createRequest !== undefined}
      >
        {createRequest === undefined ? null : (
          <CommentComposer
            key={`${createRequest.range.start}:${createRequest.range.end}`}
            onCancel={() => setComposer(undefined)}
            onSubmit={(body) => submitComment(createRequest, body)}
            pending={commentAction.state.pending}
            presentation="inline"
            quote={createRequest.quote}
            submitLabel="Comment"
            title="Comment on selection"
          />
        )}
      </AnchoredPopover>
      <CommentThreadCard
        anchorRef={activeAnchorRef}
        anchorRevision={activeAnchorRevision}
        canManage={canManage}
        canReply={canComment}
        onClose={() => {
          setActiveThreadId(undefined);
          setComposer((current) => (current?.kind === "reply" ? undefined : current));
        }}
        onDeleteMessage={(messageId) => {
          if (activeThread !== undefined) {
            setPendingDeletion({ kind: "delete-message", messageId, threadId: activeThread.id });
          }
        }}
        onDeleteThread={() => {
          if (activeThread !== undefined) {
            setPendingDeletion({ kind: "delete-thread", threadId: activeThread.id });
          }
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
            {
              onFailure: (error) => showToast(error.message, "error"),
              onSuccess: onCommentsChange,
            },
          );
        }}
        replyComposer={
          replyRequest === undefined || replyRequest.threadId !== activeThread?.id
            ? undefined
            : {
                onCancel: () => setComposer(undefined),
                onSubmit: (body) => submitComment(replyRequest, body),
                pending: commentAction.state.pending,
              }
        }
        thread={activeThread}
      />
      {editRequest === undefined ? null : (
        <CommentComposer
          initialBody={editRequest.initialBody}
          key={`${editRequest.threadId}:${editRequest.messageId}`}
          onCancel={() => setComposer(undefined)}
          onSubmit={(body) => submitComment(editRequest, body)}
          pending={commentAction.state.pending}
          submitLabel="Save"
          title="Edit comment"
        />
      )}
      <ConfirmationDialog
        confirmLabel={
          pendingDeletion?.kind === "delete-thread" ? "Delete thread" : "Delete comment"
        }
        description={
          pendingDeletion?.kind === "delete-thread"
            ? "The thread and all of its replies will be permanently deleted."
            : "This comment message will be permanently deleted."
        }
        onCancel={() => setPendingDeletion(undefined)}
        onConfirm={() => {
          if (pendingDeletion === undefined) return;
          commentAction.execute(
            { request: pendingDeletion },
            {
              onFailure: (error) => showToast(error.message, "error"),
              onSuccess: (next) => {
                onCommentsChange(next);
                if (pendingDeletion.kind === "delete-thread") setActiveThreadId(undefined);
                setPendingDeletion(undefined);
              },
            },
          );
        }}
        open={pendingDeletion !== undefined}
        pending={commentAction.state.pending}
        title={
          pendingDeletion?.kind === "delete-thread"
            ? "Delete this comment thread?"
            : "Delete this comment?"
        }
        tone="danger"
      />
    </>
  );
}

function uiError(message: string): ApiError {
  return new ApiError({ code: "ui_error", message, retryable: false, status: 0 });
}
