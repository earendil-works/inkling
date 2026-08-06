import { useEffect, useMemo, useRef, useState } from "react";
import { markdown } from "@codemirror/lang-markdown";
import { Compartment, EditorState } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import { EditorView, basicSetup } from "codemirror";
import { Effect, Fiber } from "effect";
import { Awareness } from "y-protocols/awareness";
import { yCollab } from "y-codemirror.next";
import * as Y from "yjs";

import { createCommentAnchor, resolveCommentAnchor } from "@earendil-works/jot-collaboration";
import type {
  AttachmentMetadataDto,
  CommentStateDto,
  CommentThreadDto,
  DocumentMetadataDto,
  DocumentResponse,
  PresenceDto,
  ShareResponse,
} from "@earendil-works/jot-protocol";

import { ApiError } from "./api.ts";
import type { ApiClientService } from "./api.ts";
import { useAppContext } from "./app-context.tsx";
import { makeCollaborationClient } from "./collaboration.ts";
import type { CollaborationClient, ConnectionState } from "./collaboration.ts";
import { ButtonLink } from "./components/button-link.tsx";
import { Button } from "./components/button.tsx";
import { CheckboxField } from "./components/checkbox-field.tsx";
import { SelectField } from "./components/select-field.tsx";
import { TextField } from "./components/text-field.tsx";
import { CommentComposer } from "./comment-composer.tsx";
import {
  commentDecorationsExtension,
  renderPreviewCommentBubbles,
  renderPreviewCommentComposer,
  selectedPreviewSourceRange,
  updateEditorCommentDecorations,
} from "./comments.ts";
import type { PreviewSourceRange, ProjectedCommentThread } from "./comments.ts";
import { useEffectAction } from "./effect-hooks.ts";
import { browserRuntime } from "./effect-runtime.ts";
import { renderMermaid, useRenderedMarkdown } from "./markdown.tsx";
import { colorFor, documentHref, guestName, randomId } from "./ui.ts";

interface EditorSession {
  readonly awareness: Awareness;
  readonly body: Y.Text;
  readonly client: CollaborationClient | undefined;
  readonly document: Y.Doc;
  readonly editor: EditorView;
}

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
  const editorHostRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLElement>(null);
  const commentMenuRef = useRef<HTMLDivElement>(null);
  const commentCardRef = useRef<HTMLElement>(null);
  const sessionRef = useRef<EditorSession | undefined>(undefined);
  const participantMapRef = useRef(new Map<string, PresenceDto>());
  const [metadata, setMetadata] = useState(initial.metadata);
  const [comments, setComments] = useState(initial.comments);
  const [permissions, setPermissions] = useState<readonly string[]>();
  const [body, setBody] = useState(initial.body);
  const [yRevision, setYRevision] = useState(0);
  const [sessionRevision, setSessionRevision] = useState(0);
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
  const [titleDraft, setTitleDraft] = useState(metadata.title);
  const [labelsDraft, setLabelsDraft] = useState(metadata.labels.join(", "));
  const initiallyEditable = !shared || initial.metadata.sharing.access === "edit";
  const canEdit = permissions?.includes("edit-body") ?? initiallyEditable;
  const canComment = permissions?.includes("comment") ?? false;
  const canEditMetadata = permissions?.includes("edit-metadata") ?? !shared;
  const rendered = useRenderedMarkdown(body, true);

  useEffect(() => {
    setTitleDraft(metadata.title);
    setLabelsDraft(metadata.labels.join(", "));
  }, [metadata.labels, metadata.title]);

  useEffect(() => {
    const parent = editorHostRef.current;
    if (parent === null) return;
    const yDocument = new Y.Doc();
    const yBody = yDocument.getText("body");
    const awareness = new Awareness(yDocument);
    const editable = new Compartment();
    const theme = new Compartment();
    const participantId = randomId("participant");
    const participantColor = colorFor(participantId);
    let client: CollaborationClient | undefined;
    const editor = new EditorView({
      parent,
      state: EditorState.create({
        extensions: [
          basicSetup,
          markdown(),
          yCollab(yBody, awareness),
          commentDecorationsExtension,
          editable.of(EditorView.editable.of(initiallyEditable)),
          theme.of(document.documentElement.dataset["theme"] === "dark" ? oneDark : []),
          EditorView.lineWrapping,
          EditorView.updateListener.of((update) => {
            if (!update.selectionSet || client === undefined) return;
            const selection = update.state.selection.main;
            browserRuntime.runFork(
              client.sendPresence({
                color: participantColor,
                displayName: shared ? guestName() : "Owner",
                participantId,
                selectionEnd: selection.to,
                selectionStart: selection.from,
              }),
            );
          }),
        ],
      }),
    });
    const updateBody = (): void => {
      setBody(yBody.toString());
      setYRevision((revision) => revision + 1);
    };
    yBody.observe(updateBody);
    sessionRef.current = { awareness, body: yBody, client, document: yDocument, editor };
    setSessionRevision((revision) => revision + 1);

    const collaborationFiber = browserRuntime.runFork(
      makeCollaborationClient(
        initial.metadata.id,
        yDocument,
        capabilityToken,
        shared ? guestName() : undefined,
        {
          onComments: setComments,
          onError: (message) => showToast(message, "error"),
          onMetadata: setMetadata,
          onPermissions: (actions) => {
            setPermissions(actions);
            const editableNow = actions.includes("edit-body");
            editor.dispatch({ effects: editable.reconfigure(EditorView.editable.of(editableNow)) });
            if (!editableNow) setPreviewOpen(false);
          },
          onPresence: (presence) => {
            participantMapRef.current.set(presence.participantId, presence);
            setParticipants([...participantMapRef.current.values()].slice(0, 6));
          },
          onState: (state) => {
            setConnectionState(state);
            setStatus({
              label: connectionLabel(state),
              state: state === "ready" ? "ready" : state,
            });
          },
        },
      ).pipe(
        Effect.tap((created) =>
          Effect.sync(() => {
            client = created;
            sessionRef.current = { awareness, body: yBody, client, document: yDocument, editor };
          }),
        ),
        Effect.catchAll((error) => Effect.sync(() => showToast(error.message, "error"))),
      ),
    );

    return () => {
      browserRuntime.runFork(Fiber.interrupt(collaborationFiber));
      if (client !== undefined) browserRuntime.runFork(client.close);
      yBody.unobserve(updateBody);
      editor.destroy();
      awareness.destroy();
      yDocument.destroy();
      sessionRef.current = undefined;
      participantMapRef.current.clear();
      setParticipants([]);
    };
  }, [
    api,
    capabilityToken,
    initial.metadata.id,
    initiallyEditable,
    setParticipants,
    setStatus,
    shared,
    showToast,
  ]);

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
    if (commentMenuRef.current?.matches(":popover-open") === true) {
      commentMenuRef.current.hidePopover();
    }
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
  const attachmentAction = useEffectAction<File, AttachmentMetadataDto, ApiError>((file) =>
    api.uploadAttachment(metadata.id, file),
  );
  const publishAction = useEffectAction<void, DocumentMetadataDto, ApiError>(() =>
    api.publish(metadata.id),
  );
  const shareAction = useEffectAction<
    "disabled" | "view" | "comment" | "edit",
    ShareResponse,
    ApiError
  >((access) => api.updateShare(metadata.id, access, metadata.headRevision));

  const activeThread = comments.threads.find((thread) => thread.id === activeThreadId);
  useCommentCardPosition(commentCardRef, activeThread, activeAnchorRef, activeAnchorRevision);

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
    if (commentCardRef.current?.matches(":popover-open") === false) {
      commentCardRef.current.showPopover();
    }
  };

  const openCount = comments.threads.filter((thread) => !thread.resolved).length;
  const orphaned = projectedComments.filter(
    (projection) => projection.orphaned && (showResolved || !projection.thread.resolved),
  );
  const layoutClass = `editor-layout ${canEdit ? "is-editable" : "is-reader"}${previewOpen ? " preview-open" : ""}`;

  return (
    <main className={layoutClass} id="app" onClick={handleWorkbenchClick} tabIndex={-1}>
      <section className="document-bar">
        <div className="document-identity">
          <span>
            {metadata.rfcNumber === undefined
              ? "Document"
              : `RFC ${String(metadata.rfcNumber).padStart(4, "0")}`}
          </span>
          <input
            aria-label="Document title"
            className="title-input"
            data-title=""
            disabled={!canEditMetadata}
            onBlur={() => {
              if (titleDraft !== metadata.title) updateMetadata({ title: titleDraft });
            }}
            onChange={(event) => setTitleDraft(event.currentTarget.value)}
            value={titleDraft}
          />
        </div>
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
            onClick={() => setPreviewOpen((open) => !open)}
            type="button"
          >
            Preview
          </Button>
          <label className="toolbar-button attachment-button">
            Attach
            <input
              accept="image/png,image/jpeg,image/gif,image/webp,application/pdf,text/plain"
              data-attachment=""
              disabled={!canEdit}
              onChange={(event) => {
                const input = event.currentTarget;
                const file = input.files?.[0];
                if (file === undefined) return;
                attachmentAction.execute(file, {
                  onFailure: (error) => showToast(error.message, "error"),
                  onSuccess: (attachment) => {
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
                    input.value = "";
                    showToast("Attachment uploaded and linked.", "success");
                  },
                });
              }}
              type="file"
            />
          </label>
          <Button
            variant="toolbar"
            onClick={() => commentMenuRef.current?.showPopover()}
            type="button"
          >
            Comments{" "}
            <span className="comment-count" data-comment-count="">
              {openCount}
            </span>
          </Button>
          <details className="document-details" data-document-details="">
            <summary className="toolbar-button">Details</summary>
            <div className="document-details__menu">
              <SelectField
                data-state=""
                disabled={!canEditMetadata}
                label="State"
                onChange={(event) => updateMetadata({ lifecycleState: event.currentTarget.value })}
                value={metadata.lifecycleState}
              >
                {[
                  metadata.lifecycleState,
                  "draft",
                  "discussion",
                  "accepted",
                  "implemented",
                  "abandoned",
                ]
                  .filter((value, index, values) => values.indexOf(value) === index)
                  .map((value) => (
                    <option key={value}>{value}</option>
                  ))}
              </SelectField>
              <SelectField
                data-visibility=""
                disabled={!canEditMetadata}
                label="Visibility"
                onChange={(event) => {
                  const visibility =
                    event.currentTarget.value === "public" ? "public" : "workspace";
                  if (
                    visibility === "public" &&
                    metadata.sensitivity === "confidential" &&
                    !window.confirm("Publish confidential metadata as public?")
                  ) {
                    event.currentTarget.value = metadata.visibility;
                    return;
                  }
                  updateMetadata({
                    confirmConfidentialPublic: visibility === "public",
                    visibility,
                  });
                }}
                value={metadata.visibility}
              >
                <option value="workspace">Workspace</option>
                <option value="public">Public</option>
              </SelectField>
              <SelectField
                data-sensitivity=""
                disabled={!canEditMetadata}
                label="Sensitivity"
                onChange={(event) => updateMetadata({ sensitivity: event.currentTarget.value })}
                value={metadata.sensitivity}
              >
                <option value="normal">Normal</option>
                <option value="confidential">Confidential</option>
              </SelectField>
              <TextField
                data-labels=""
                disabled={!canEditMetadata}
                label="Labels"
                onBlur={() =>
                  updateMetadata({
                    labels: labelsDraft
                      .split(",")
                      .map((label) => label.trim())
                      .filter(Boolean),
                  })
                }
                onChange={(event) => setLabelsDraft(event.currentTarget.value)}
                placeholder="Comma separated"
                value={labelsDraft}
              />
            </div>
          </details>
          {shared ? null : (
            <>
              <Button
                variant="toolbar"
                data-share=""
                onClick={() => {
                  const selected = window.prompt(
                    "Share access: disabled, view, comment, or edit",
                    metadata.sharing.access,
                  );
                  if (
                    selected !== "disabled" &&
                    selected !== "view" &&
                    selected !== "comment" &&
                    selected !== "edit"
                  )
                    return;
                  shareAction.execute(selected, {
                    onFailure: (error) => showToast(error.message, "error"),
                    onSuccess: (response) => {
                      setMetadata((current) => ({
                        ...current,
                        headRevision: current.headRevision + 1,
                        sharing: response.policy,
                      }));
                      if (response.capabilityUrl === undefined) {
                        showToast("Share access updated.", "success");
                      } else {
                        browserRuntime.runFork(
                          Effect.tryPromise({
                            catch: () => undefined,
                            try: () => navigator.clipboard.writeText(response.capabilityUrl ?? ""),
                          }).pipe(Effect.ignore),
                        );
                        showToast("Capability URL copied. It will not be shown again.", "success");
                      }
                    },
                  });
                }}
                type="button"
              >
                Share
              </Button>
              <Button
                size="small"
                variant="primary"
                data-publish=""
                disabled={publishAction.state.pending}
                onClick={() =>
                  publishAction.execute(undefined, {
                    onFailure: (error) => showToast(error.message, "error"),
                    onSuccess: (next) => {
                      setMetadata(next);
                      showToast("Revision published.", "success");
                    },
                  })
                }
                type="button"
              >
                {metadata.publishedRevision === undefined ? "Publish" : "Republish"}
              </Button>
            </>
          )}
        </div>
      </section>
      <section className="workbench">
        <div className="source-pane" data-source-pane="">
          <div className="pane-label">
            <span>Markdown</span>
            <span data-save-state="">{connectionLabel(connectionState)}</span>
          </div>
          <div className="editor-host" data-editor="" ref={editorHostRef} />
        </div>
        <div className="preview-pane" data-preview-pane="">
          <div className="pane-label">
            <span>Preview</span>
            <Button
              aria-label="Close preview"
              variant="icon"
              data-preview-close=""
              onClick={() => setPreviewOpen(false)}
              type="button"
            >
              ×
            </Button>
          </div>
          <article
            className="markdown-body"
            data-preview=""
            onKeyUp={() => updatePreviewSelection(previewRef.current, setPreviewSelection)}
            onPointerUp={() => updatePreviewSelection(previewRef.current, setPreviewSelection)}
            ref={previewRef}
          />
        </div>
      </section>
      <div
        aria-label="Comment controls"
        className="comment-menu"
        id="comment-menu"
        popover="auto"
        ref={commentMenuRef}
      >
        <div className="comment-menu__heading">
          <div>
            <p className="eyebrow">Anchored discussion</p>
            <b>Comments in context</b>
          </div>
          <Button
            aria-label="Close comment controls"
            variant="icon"
            onClick={() => commentMenuRef.current?.hidePopover()}
            type="button"
          >
            ×
          </Button>
        </div>
        <p>Select Markdown or rendered text. Comments stay attached as the document changes.</p>
        <Button
          variant="primary"
          data-comment-new=""
          disabled={!canComment}
          onClick={commentOnSelection}
          type="button"
        >
          Comment on selection
        </Button>
        <CheckboxField
          checked={showResolved}
          className="resolved-toggle"
          data-show-resolved=""
          label="Show resolved threads"
          onChange={(event) => setShowResolved(event.currentTarget.checked)}
        />
        <div className="orphaned-comments" data-orphaned-comments="" hidden={orphaned.length === 0}>
          {orphaned.length === 0 ? null : (
            <p>
              <b>
                {orphaned.length} orphaned {orphaned.length === 1 ? "thread" : "threads"}
              </b>
              <br />
              Its original text was removed.
            </p>
          )}
          {orphaned.map((projection) => (
            <Button
              data-comment-bubble={projection.thread.id}
              data-comment-surface="preview"
              key={projection.thread.id}
              type="button"
            >
              <span>{projection.thread.messages[0]?.authorDisplayName ?? "Unknown author"}</span>
              {projection.thread.messages[0]?.body ?? "Open comment"}
            </Button>
          ))}
        </div>
      </div>
      <aside
        aria-label="Comment thread"
        className="comment-card"
        data-comment-card=""
        popover="auto"
        ref={commentCardRef}
      >
        {activeThread === undefined ? null : (
          <CommentThread
            canManage={permissions?.includes("manage-comments") ?? false}
            onClose={() => setActiveThreadId(undefined)}
            onDeleteMessage={(messageId) => {
              if (!window.confirm("Delete this comment message?")) return;
              commentAction.execute(
                { request: { kind: "delete-message", messageId, threadId: activeThread.id } },
                { onFailure: (error) => showToast(error.message, "error"), onSuccess: setComments },
              );
            }}
            onDeleteThread={() => {
              if (!window.confirm("Delete this comment thread?")) return;
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
            onEdit={(messageId, initialBody) =>
              setComposer({ kind: "edit", initialBody, messageId, threadId: activeThread.id })
            }
            onReply={() => {
              const parent = activeThread.messages.at(-1);
              if (parent !== undefined) {
                setComposer({
                  kind: "reply",
                  parentId: parent.id,
                  quote: activeThread.anchor.quote,
                  threadId: activeThread.id,
                });
              }
            }}
            onResolve={() =>
              commentAction.execute(
                {
                  request: {
                    kind: "resolve",
                    resolved: !activeThread.resolved,
                    threadId: activeThread.id,
                  },
                },
                { onFailure: (error) => showToast(error.message, "error"), onSuccess: setComments },
              )
            }
            thread={activeThread}
          />
        )}
      </aside>
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

interface CommentThreadProps {
  readonly canManage: boolean;
  readonly onClose: () => void;
  readonly onDeleteMessage: (messageId: string) => void;
  readonly onDeleteThread: () => void;
  readonly onEdit: (messageId: string, body: string) => void;
  readonly onReply: () => void;
  readonly onResolve: () => void;
  readonly thread: CommentThreadDto;
}

function CommentThread({
  canManage,
  onClose,
  onDeleteMessage,
  onDeleteThread,
  onEdit,
  onReply,
  onResolve,
  thread,
}: CommentThreadProps): React.JSX.Element {
  return (
    <section className={`comment-thread ${thread.resolved ? "is-resolved" : ""}`}>
      <div className="comment-thread__heading">
        <span>Thread</span>
        <Button
          aria-label="Close comment thread"
          variant="icon"
          data-comment-close=""
          onClick={onClose}
          type="button"
        >
          ×
        </Button>
      </div>
      <blockquote>{thread.anchor.quote || "Orphaned selection"}</blockquote>
      {thread.messages.map((message) => (
        <div className="comment-message" key={message.id}>
          <b>{message.authorDisplayName}</b>
          <p>{message.body}</p>
          <span>
            <Button
              data-edit-message={`${thread.id}:${message.id}`}
              onClick={() => onEdit(message.id, message.body)}
              type="button"
            >
              Edit
            </Button>
            <Button
              data-delete-message={`${thread.id}:${message.id}`}
              onClick={() => onDeleteMessage(message.id)}
              type="button"
            >
              Delete
            </Button>
          </span>
        </div>
      ))}
      <div className="comment-actions">
        <Button data-reply-thread={thread.id} onClick={onReply} type="button">
          Reply
        </Button>
        <Button data-resolve-thread={thread.id} onClick={onResolve} type="button">
          {thread.resolved ? "Reopen" : "Resolve"}
        </Button>
        {canManage ? (
          <Button data-delete-thread={thread.id} onClick={onDeleteThread} type="button">
            Delete thread
          </Button>
        ) : null}
      </div>
    </section>
  );
}

function connectionLabel(state: ConnectionState): string {
  const labels: Record<ConnectionState, string> = {
    connecting: "Connecting",
    disconnected: "Offline — edits unsaved",
    ready: "Saved",
    saving: "Saving…",
  };
  return labels[state];
}

function updatePreviewSelection(
  preview: HTMLElement | null,
  setSelection: (range: PreviewSourceRange | undefined) => void,
): void {
  if (preview === null) return;
  window.setTimeout(() => setSelection(selectedPreviewSourceRange(preview)));
}

function uiError(message: string): ApiError {
  return new ApiError({ code: "ui_error", message, retryable: false, status: 0 });
}

function useCommentCardPosition(
  cardRef: React.RefObject<HTMLElement | null>,
  thread: CommentThreadDto | undefined,
  anchorRef: React.MutableRefObject<HTMLElement | undefined>,
  anchorRevision: number,
): void {
  useEffect(() => {
    const card = cardRef.current;
    if (card === null) return;
    if (thread === undefined) {
      if (card.matches(":popover-open")) card.hidePopover();
      document
        .querySelectorAll(".segment-comment-bubble.is-active")
        .forEach((bubble) => bubble.classList.remove("is-active"));
      return;
    }
    if (!card.matches(":popover-open")) card.showPopover();
    document.querySelectorAll<HTMLElement>("[data-comment-bubble]").forEach((bubble) => {
      bubble.classList.toggle("is-active", bubble.dataset["commentBubble"] === thread.id);
    });
    const position = (): void => {
      if (!card.matches(":popover-open")) return;
      if (matchMedia("(width <= 52rem)").matches) {
        card.style.removeProperty("--comment-card-left");
        card.style.removeProperty("--comment-card-top");
        return;
      }
      const anchor = anchorRef.current;
      if (anchor === undefined || !anchor.isConnected) return;
      const anchorRect = anchor.getBoundingClientRect();
      const cardRect = card.getBoundingClientRect();
      const gap = 12;
      const left = Math.max(
        gap,
        Math.min(
          innerWidth - cardRect.width - gap,
          anchorRect.right + gap + cardRect.width <= innerWidth
            ? anchorRect.right + gap
            : anchorRect.left - cardRect.width - gap,
        ),
      );
      const top = Math.max(gap, Math.min(innerHeight - cardRect.height - gap, anchorRect.top - 18));
      card.style.setProperty("--comment-card-left", `${left}px`);
      card.style.setProperty("--comment-card-top", `${top}px`);
    };
    requestAnimationFrame(position);
    document.addEventListener("scroll", position, true);
    window.addEventListener("resize", position);
    return () => {
      document.removeEventListener("scroll", position, true);
      window.removeEventListener("resize", position);
    };
  }, [anchorRef, anchorRevision, cardRef, thread]);
}
