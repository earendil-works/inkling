import { useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { Effect, Fiber } from "effect";

import { createCommentAnchor, resolveCommentAnchor } from "@earendil-works/jot-collaboration";
import type { CommentStateDto } from "@earendil-works/jot-protocol";

import { ApiError } from "../api.ts";
import type { ApiClientService } from "../api.ts";
import { useAppContext } from "../app-context.tsx";
import {
  renderPreviewCommentBubbles,
  renderPreviewCommentComposer,
  selectedPreviewSourceRange,
  updateEditorCommentDecorations,
} from "../comments.ts";
import type { PreviewSourceRange, ProjectedCommentThread } from "../comments.ts";
import { useEffectAction } from "../effect-hooks.ts";
import { browserRuntime } from "../effect-runtime.ts";
import type { EditorSession } from "../use-editor-session.ts";
import { CommentComposer } from "./comment-composer.tsx";
import { CommentControls } from "./comment-controls.tsx";
import type { CommentControlsHandle } from "./comment-controls.tsx";
import { CommentThreadCard } from "./comment-thread-card.tsx";

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
    previewRef,
    previewRevision,
    previewSelection,
    sessionRef,
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
  const handleWorkbenchClick = (target: EventTarget): void => {
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

  useImperativeHandle(ref, () => ({
    handleWorkbenchClick,
    openControls: () => controlsRef.current?.open(),
    setPreviewSelection,
  }));

  const activeThread = comments.threads.find((thread) => thread.id === activeThreadId);
  const orphaned = projectedComments.filter(
    (projection) => projection.orphaned && (showResolved || !projection.thread.resolved),
  );

  return (
    <>
      <CommentControls
        canComment={canComment}
        onCommentOnSelection={commentOnSelection}
        onShowResolvedChange={setShowResolved}
        orphaned={orphaned}
        ref={controlsRef}
        showResolved={showResolved}
      />
      <CommentThreadCard
        anchorRef={activeAnchorRef}
        anchorRevision={activeAnchorRevision}
        canManage={canManage}
        onClose={() => setActiveThreadId(undefined)}
        onDeleteMessage={(messageId) => {
          if (activeThread === undefined || !window.confirm("Delete this comment message?")) return;
          commentAction.execute(
            { request: { kind: "delete-message", messageId, threadId: activeThread.id } },
            {
              onFailure: (error) => showToast(error.message, "error"),
              onSuccess: onCommentsChange,
            },
          );
        }}
        onDeleteThread={() => {
          if (activeThread === undefined || !window.confirm("Delete this comment thread?")) return;
          commentAction.execute(
            { request: { kind: "delete-thread", threadId: activeThread.id } },
            {
              onFailure: (error) => showToast(error.message, "error"),
              onSuccess: (next) => {
                onCommentsChange(next);
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
            {
              onFailure: (error) => showToast(error.message, "error"),
              onSuccess: onCommentsChange,
            },
          );
        }}
        thread={activeThread}
      />
      {composer === undefined ? null : (
        <CommentComposer
          initialBody={composer.kind === "edit" ? composer.initialBody : undefined}
          onCancel={() => setComposer(undefined)}
          onSubmit={(body) =>
            commentAction.execute(
              { body, request: composer },
              { onFailure: (error) => showToast(error.message, "error"), onSuccess: finishComment },
            )
          }
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
    </>
  );
}

function uiError(message: string): ApiError {
  return new ApiError({ code: "ui_error", message, retryable: false, status: 0 });
}
