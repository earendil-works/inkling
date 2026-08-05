import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, basicSetup } from "codemirror";
import { markdown } from "@codemirror/lang-markdown";
import { oneDark } from "@codemirror/theme-one-dark";
import { Effect } from "effect";
import mermaid from "mermaid";
import { Awareness } from "y-protocols/awareness";
import { yCollab } from "y-codemirror.next";
import * as Y from "yjs";

import { createCommentAnchor, resolveCommentAnchor } from "@earendil-works/jot-collaboration";
import type {
  CommentThreadDto,
  DocumentMetadataDto,
  PresenceDto,
} from "@earendil-works/jot-protocol";
import { makeMarkdownRenderer } from "@earendil-works/jot-renderer";

import { makeApiClient } from "./api.ts";
import type { ApiError } from "./api.ts";
import { makeCollaborationClient } from "./collaboration.ts";
import type { CollaborationClient, ConnectionState } from "./collaboration.ts";
import {
  commentDecorationsExtension,
  renderPreviewCommentBubbles,
  renderPreviewCommentComposer,
  selectedPreviewSourceRange,
  updateEditorCommentDecorations,
} from "./comments.ts";
import type { PreviewSourceRange, ProjectedCommentThread } from "./comments.ts";

const app = requireElement<HTMLElement>("#app");
const statusElement = requireElement<HTMLElement>("[data-api-status]");
const participantsElement = requireElement<HTMLElement>("[data-participants]");
const toastRegion = requireElement<HTMLElement>("[data-toasts]");
const capabilityToken = new URL(location.href).searchParams.get("cap") ?? undefined;
const api = makeApiClient(capabilityToken);
const renderer = makeMarkdownRenderer();
let cleanup: Effect.Effect<void> = Effect.void;

mermaid.initialize({
  securityLevel: "strict",
  startOnLoad: false,
  theme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "neutral",
});

installThemeControl();
Effect.runFork(route().pipe(Effect.catchAll(showFatal)));

function route(): Effect.Effect<void, ApiError> {
  const shared = /^\/share\/([^/]+)$/u.exec(location.pathname);
  const documentRoute = /^\/documents\/([^/]+)$/u.exec(location.pathname);
  if (shared?.[1] !== undefined) {
    return renderEditor(decodeURIComponent(shared[1]), true);
  }
  if (documentRoute?.[1] !== undefined) {
    return renderEditor(decodeURIComponent(documentRoute[1]), false);
  }
  return api.authenticationStatus.pipe(
    Effect.flatMap((status) => {
      setApiStatus(
        "ready",
        status.authenticated ? "Workspace connected" : "Authentication required",
      );
      if (status.needsSetup) {
        return renderAuthentication("setup", status.authenticationMethods);
      }
      return status.authenticated
        ? renderWorkspace()
        : renderAuthentication("login", status.authenticationMethods);
    }),
  );
}

function renderAuthentication(
  mode: "login" | "setup",
  methods: readonly ("password" | "google")[],
): Effect.Effect<void> {
  return Effect.sync(() => {
    app.className = "auth-layout";
    app.innerHTML = `
      <section class="auth-copy">
        <p class="eyebrow">${mode === "setup" ? "First run / local owner" : "Private workspace"}</p>
        <h1>${mode === "setup" ? "Make this workspace yours." : "Continue writing."}</h1>
        <p>Jot keeps the working head private, journals every accepted edit, and publishes only explicit revisions.</p>
      </section>
      <section class="auth-panel" aria-labelledby="auth-title">
        <p class="folio">JOT / AUTHORITY</p>
        <h2 id="auth-title">${mode === "setup" ? "Set owner password" : "Owner sign in"}</h2>
        <form data-auth-form>
          ${methods.includes("password") ? `<label>Password <input name="password" type="password" minlength="12" autocomplete="${mode === "setup" ? "new-password" : "current-password"}" required /></label><button class="primary-button" type="submit">${mode === "setup" ? "Initialize workspace" : "Sign in"}</button>` : ""}
          ${methods.includes("google") ? '<a class="primary-button google-button" href="/api/auth/google/start">Continue with Google</a>' : ""}
          <p class="form-error" data-form-error></p>
        </form>
      </section>`;
    const form = requireElement<HTMLFormElement>("[data-auth-form]");
    const password = document.querySelector<HTMLInputElement>("input[name=password]");
    const error = requireElement<HTMLElement>("[data-form-error]");
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      error.textContent = "";
      if (password === null) return;
      const operation = mode === "setup" ? api.setup(password.value) : api.login(password.value);
      runUi(
        operation.pipe(
          Effect.tap(() => Effect.sync(() => location.assign("/"))),
          Effect.catchAll((failure) =>
            Effect.sync(() => {
              error.textContent = failure.message;
            }),
          ),
        ),
      );
    });
    password?.focus();
  });
}

function renderWorkspace(): Effect.Effect<void, ApiError> {
  return api.listDocuments().pipe(
    Effect.tap((catalog) =>
      Effect.sync(() => {
        app.className = "workspace-layout";
        app.innerHTML = `
          <section class="workspace-heading">
            <div>
              <p class="eyebrow">Workspace / recent activity</p>
              <h1>The working set.</h1>
            </div>
            <button class="primary-button" type="button" data-new-document>New document</button>
          </section>
          <section class="catalog-tools" aria-label="Document tools">
            <label class="search-field"><span>Search</span><input type="search" data-search placeholder="Title, body, people, state…" /></label>
            <button class="text-button" type="button" data-settings>API & agents</button>
            <button class="text-button" type="button" data-logout>Sign out</button>
          </section>
          <section class="catalog" data-catalog aria-live="polite"></section>
          <dialog class="new-document" data-new-dialog>
            <form method="dialog" data-new-form>
              <div class="dialog-heading"><p class="eyebrow">Begin a working head</p><button class="icon-button" value="cancel" aria-label="Close">×</button></div>
              <label>Title <input name="title" maxlength="300" required autofocus /></label>
              <label class="checkbox"><input name="rfc" type="checkbox" /> Allocate an RFC number</label>
              <label>Opening Markdown <textarea name="body" rows="9" placeholder="# Context\n\nStart with the decision…"></textarea></label>
              <button class="primary-button" value="default" type="submit">Create document</button>
              <p class="form-error" data-new-error></p>
            </form>
          </dialog>
          <dialog class="settings-dialog" data-settings-dialog>
            <form method="dialog" data-settings-form>
              <div class="dialog-heading"><p class="eyebrow">API keys / agent access</p><button class="icon-button" value="cancel" aria-label="Close">×</button></div>
              <div data-api-keys><p>Loading keys…</p></div>
              <label>New key label <input name="api-key-label" maxlength="200" placeholder="Laptop agent" /></label>
              <button class="primary-button" value="create" type="submit">Create API key</button>
              <section class="agent-instructions" data-agent-instructions hidden><b>Copy this now — the key is shown once.</b><pre data-agent-command></pre><button class="text-button" type="button" data-copy-agent>Copy setup command</button></section>
              <p class="form-error" data-settings-error></p>
            </form>
          </dialog>`;
        renderCatalog(catalog.documents);
        const search = requireElement<HTMLInputElement>("[data-search]");
        let searchTimer: number | undefined;
        search.addEventListener("input", () => {
          if (searchTimer !== undefined) window.clearTimeout(searchTimer);
          searchTimer = window.setTimeout(() => {
            runUi(
              api.listDocuments(search.value).pipe(
                Effect.tap((result) => Effect.sync(() => renderCatalog(result.documents))),
                Effect.catchAll(showToastError),
              ),
            );
          }, 180);
        });
        const dialog = requireElement<HTMLDialogElement>("[data-new-dialog]");
        requireElement<HTMLButtonElement>("[data-new-document]").addEventListener("click", () =>
          dialog.showModal(),
        );
        const form = requireElement<HTMLFormElement>("[data-new-form]");
        form.addEventListener("submit", (event) => {
          const submitter = event.submitter;
          if (submitter instanceof HTMLButtonElement && submitter.value === "cancel") {
            return;
          }
          event.preventDefault();
          const title = requireElement<HTMLInputElement>("input[name=title]");
          const body = requireElement<HTMLTextAreaElement>("textarea[name=body]");
          const allocateRfc = requireElement<HTMLInputElement>("input[name=rfc]");
          runUi(
            api
              .createDocument({
                allocateRfc: allocateRfc.checked,
                body: body.value,
                creationKey: crypto.randomUUID(),
                title: title.value,
              })
              .pipe(
                Effect.tap((document) =>
                  Effect.sync(() => location.assign(`/documents/${document.metadata.id}`)),
                ),
                Effect.catchAll((failure) =>
                  Effect.sync(() => {
                    requireElement<HTMLElement>("[data-new-error]").textContent = failure.message;
                  }),
                ),
              ),
          );
        });
        const settingsDialog = requireElement<HTMLDialogElement>("[data-settings-dialog]");
        let knownApiKeys: readonly {
          readonly id: string;
          readonly label: string;
          readonly revokedAt?: string | undefined;
        }[] = [];
        const renderApiKeys = (
          keys: readonly {
            readonly id: string;
            readonly label: string;
            readonly revokedAt?: string | undefined;
          }[],
        ): void => {
          knownApiKeys = keys;
          requireElement<HTMLElement>("[data-api-keys]").innerHTML =
            keys.length === 0
              ? "<p>No API keys created.</p>"
              : keys
                  .map(
                    (key) =>
                      `<div class="api-key-row"><span><b>${escapeHtml(key.label)}</b><small>${key.revokedAt === undefined ? "Active" : "Revoked"}</small></span>${key.revokedAt === undefined ? `<button class="text-button" type="button" data-revoke-key="${escapeHtml(key.id)}">Revoke</button>` : ""}</div>`,
                  )
                  .join("");
          document.querySelectorAll<HTMLButtonElement>("[data-revoke-key]").forEach((button) => {
            button.addEventListener("click", () => {
              const keyId = button.dataset["revokeKey"];
              if (keyId === undefined || !window.confirm("Revoke this API key?")) return;
              runUi(
                api.revokeApiKey(keyId).pipe(
                  Effect.zipRight(api.listApiKeys),
                  Effect.tap((next) => Effect.sync(() => renderApiKeys(next))),
                  Effect.catchAll(showToastError),
                ),
              );
            });
          });
        };
        requireElement<HTMLButtonElement>("[data-settings]").addEventListener("click", () => {
          settingsDialog.showModal();
          runUi(
            api.listApiKeys.pipe(
              Effect.tap((keys) => Effect.sync(() => renderApiKeys(keys))),
              Effect.catchAll((failure) =>
                Effect.sync(() => {
                  requireElement<HTMLElement>("[data-settings-error]").textContent =
                    failure.message;
                }),
              ),
            ),
          );
        });
        requireElement<HTMLFormElement>("[data-settings-form]").addEventListener(
          "submit",
          (event) => {
            const submitter = event.submitter;
            if (!(submitter instanceof HTMLButtonElement) || submitter.value !== "create") return;
            event.preventDefault();
            const label = requireElement<HTMLInputElement>("input[name=api-key-label]").value;
            if (label.trim() === "") return;
            runUi(
              api.createApiKey(label).pipe(
                Effect.tap((created) =>
                  Effect.sync(() => {
                    const command = `jot instance add workspace ${location.origin} ${created.key}`;
                    const instructions = requireElement<HTMLElement>("[data-agent-instructions]");
                    instructions.hidden = false;
                    requireElement<HTMLElement>("[data-agent-command]").textContent = command;
                    renderApiKeys([created.metadata, ...knownApiKeys]);
                  }),
                ),
                Effect.catchAll(showToastError),
              ),
            );
          },
        );
        requireElement<HTMLButtonElement>("[data-copy-agent]").addEventListener("click", () => {
          const command = requireElement<HTMLElement>("[data-agent-command]").textContent ?? "";
          runUi(
            Effect.tryPromise({
              catch: () => undefined,
              try: () => navigator.clipboard.writeText(command),
            }).pipe(Effect.ignore),
          );
        });
        requireElement<HTMLButtonElement>("[data-logout]").addEventListener("click", () => {
          runUi(api.logout.pipe(Effect.tap(() => Effect.sync(() => location.reload()))));
        });
      }),
    ),
    Effect.asVoid,
  );
}

function renderCatalog(
  documents: readonly { readonly excerpt: string; readonly metadata: DocumentMetadataDto }[],
): void {
  const catalog = requireElement<HTMLElement>("[data-catalog]");
  if (documents.length === 0) {
    catalog.innerHTML = `<div class="empty-state"><span>Ø</span><h2>No documents found.</h2><p>Start a document or adjust the search.</p></div>`;
    return;
  }
  catalog.innerHTML = documents
    .map(({ excerpt, metadata }, index) => {
      const number =
        metadata.rfcNumber === undefined
          ? "NOTE"
          : `RFC ${String(metadata.rfcNumber).padStart(4, "0")}`;
      return `<a class="catalog-row" href="/documents/${encodeURIComponent(metadata.id)}">
        <span class="catalog-row__index">${String(index + 1).padStart(2, "0")}</span>
        <span class="catalog-row__main"><strong>${escapeHtml(metadata.title)}</strong><small>${escapeHtml(excerpt || "No body text yet")}</small></span>
        <span class="catalog-row__meta"><b>${number}</b><span>${escapeHtml(metadata.lifecycleState)}</span><time>${formatDate(metadata.updatedAt)}</time></span>
      </a>`;
    })
    .join("");
}

function renderEditor(documentId: string, shared: boolean): Effect.Effect<void, ApiError> {
  return api.readDocument(documentId).pipe(
    Effect.flatMap((initial) =>
      Effect.sync(() => {
        const initiallyEditable = !shared || initial.metadata.sharing.access === "edit";
        app.className = `editor-layout ${initiallyEditable ? "is-editable" : "is-reader"}`;
        app.innerHTML = `
          <section class="document-bar">
            <div class="document-identity">
              <span>${initial.metadata.rfcNumber === undefined ? "Document" : `RFC ${String(initial.metadata.rfcNumber).padStart(4, "0")}`}</span>
              <input class="title-input" data-title value="${escapeHtml(initial.metadata.title)}" aria-label="Document title" />
            </div>
            <div class="document-actions">
              <button class="toolbar-button preview-toggle" type="button" data-preview-toggle aria-pressed="false">Preview</button>
              <label class="toolbar-button attachment-button">Attach<input type="file" data-attachment accept="image/png,image/jpeg,image/gif,image/webp,application/pdf,text/plain" /></label>
              <button class="toolbar-button" type="button" popovertarget="comment-menu">Comments <span class="comment-count" data-comment-count>0</span></button>
              <details class="document-details" data-document-details>
                <summary class="toolbar-button">Details</summary>
                <div class="document-details__menu">
                  <label>State<select data-state><option>${escapeHtml(initial.metadata.lifecycleState)}</option><option>draft</option><option>discussion</option><option>accepted</option><option>implemented</option><option>abandoned</option></select></label>
                  <label>Visibility<select data-visibility><option value="workspace">Workspace</option><option value="public">Public</option></select></label>
                  <label>Sensitivity<select data-sensitivity><option value="normal">Normal</option><option value="confidential">Confidential</option></select></label>
                  <label>Labels<input data-labels value="${escapeHtml(initial.metadata.labels.join(", "))}" placeholder="Comma separated" /></label>
                </div>
              </details>
              ${shared ? "" : '<button class="toolbar-button" type="button" data-share>Share</button><button class="primary-button primary-button--small" type="button" data-publish>Publish</button>'}
            </div>
          </section>
          <section class="workbench">
            <div class="source-pane" data-source-pane>
              <div class="pane-label"><span>Markdown</span><span data-save-state>Connecting</span></div>
              <div class="editor-host" data-editor></div>
            </div>
            <div class="preview-pane" data-preview-pane>
              <div class="pane-label"><span>Preview</span><button class="icon-button" type="button" data-preview-close aria-label="Close preview">×</button></div>
              <article class="markdown-body" data-preview></article>
            </div>
          </section>
          <div class="comment-menu" id="comment-menu" popover aria-label="Comment controls">
            <div class="comment-menu__heading"><div><p class="eyebrow">Anchored discussion</p><b>Comments in context</b></div><button class="icon-button" type="button" popovertarget="comment-menu" popovertargetaction="hide" aria-label="Close comment controls">×</button></div>
            <p>Select Markdown or rendered text. Comments stay attached as the document changes.</p>
            <button class="primary-button" type="button" data-comment-new>Comment on selection</button>
            <label class="resolved-toggle"><input type="checkbox" data-show-resolved /> Show resolved threads</label>
            <div class="orphaned-comments" data-orphaned-comments hidden></div>
          </div>
          <aside class="comment-card" data-comment-card popover="auto" aria-label="Comment thread"></aside>`;

        let metadata = initial.metadata;
        let comments = initial.comments;
        let permissions: readonly string[] = [];
        let client: CollaborationClient | undefined;
        let previewGeneration = 0;
        let commentProjectionGeneration = 0;
        let projectedComments: readonly ProjectedCommentThread[] = [];
        let activeThreadId: string | undefined;
        let activeCommentSurface: "preview" | "source" = "preview";
        let activeCommentAnchor: HTMLElement | undefined;
        let previewSelection: PreviewSourceRange | undefined;
        const remoteParticipants = new Map<string, PresenceDto>();
        const yDocument = new Y.Doc();
        const yBody = yDocument.getText("body");
        const awareness = new Awareness(yDocument);
        const editable = new Compartment();
        const theme = new Compartment();
        const participantId = crypto.randomUUID();
        const participantColor = colorFor(participantId);
        const editor = new EditorView({
          parent: requireElement<HTMLElement>("[data-editor]"),
          state: EditorState.create({
            extensions: [
              basicSetup,
              markdown(),
              yCollab(yBody, awareness),
              commentDecorationsExtension,
              editable.of(EditorView.editable.of(false)),
              theme.of(document.documentElement.dataset["theme"] === "dark" ? oneDark : []),
              EditorView.lineWrapping,
              EditorView.updateListener.of((update) => {
                if (!update.selectionSet || client === undefined) return;
                const selection = update.state.selection.main;
                runUi(
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

        const updatePreview = (): void => {
          refreshCommentProjections();
          const generation = ++previewGeneration;
          runUi(
            renderer.render(yBody.toString(), { sourcePositions: true }).pipe(
              Effect.tap((rendered) =>
                Effect.sync(() => {
                  if (generation !== previewGeneration) return;
                  const preview = requireElement<HTMLElement>("[data-preview]");
                  preview.innerHTML = rendered.html;
                }),
              ),
              Effect.tap(() => renderMermaid()),
              Effect.tap(() =>
                Effect.sync(() => {
                  if (generation !== previewGeneration) return;
                  renderCommentProjections();
                }),
              ),
              Effect.catchAll((failure) =>
                Effect.sync(() => showToast(`Preview failed: ${failure.message}`, "error")),
              ),
            ),
          );
        };
        yBody.observe(updatePreview);

        const updateMetadataView = (next: DocumentMetadataDto): void => {
          metadata = next;
          requireElement<HTMLInputElement>("[data-title]").value = next.title;
          requireElement<HTMLSelectElement>("[data-state]").value = next.lifecycleState;
          requireElement<HTMLSelectElement>("[data-visibility]").value = next.visibility;
          requireElement<HTMLSelectElement>("[data-sensitivity]").value = next.sensitivity;
          requireElement<HTMLInputElement>("[data-labels]").value = next.labels.join(", ");
          const publishButton = document.querySelector<HTMLButtonElement>("[data-publish]");
          if (publishButton !== null) {
            publishButton.textContent =
              next.publishedRevision === undefined ? "Publish" : "Republish";
          }
        };
        const updatePermissions = (actions: readonly string[]): void => {
          permissions = actions;
          const canEdit = actions.includes("edit-body");
          app.classList.toggle("is-editable", canEdit);
          app.classList.toggle("is-reader", !canEdit);
          if (!canEdit) app.classList.remove("preview-open");
          editor.dispatch({ effects: editable.reconfigure(EditorView.editable.of(canEdit)) });
          requireElement<HTMLButtonElement>("[data-comment-new]").disabled =
            !actions.includes("comment");
          requireElement<HTMLInputElement>("[data-attachment]").disabled = !canEdit;
          const canEditMetadata = actions.includes("edit-metadata");
          requireElement<HTMLInputElement>("[data-title]").disabled = !canEditMetadata;
          requireElement<HTMLSelectElement>("[data-state]").disabled = !canEditMetadata;
          requireElement<HTMLSelectElement>("[data-visibility]").disabled = !canEditMetadata;
          requireElement<HTMLSelectElement>("[data-sensitivity]").disabled = !canEditMetadata;
          requireElement<HTMLInputElement>("[data-labels]").disabled = !canEditMetadata;
        };
        const updateConnectionState = (state: ConnectionState): void => {
          const labels: Record<ConnectionState, string> = {
            connecting: "Connecting",
            disconnected: "Offline — edits unsaved",
            ready: "Saved",
            saving: "Saving…",
          };
          requireElement<HTMLElement>("[data-save-state]").textContent = labels[state];
          setApiStatus(state === "ready" ? "ready" : state, labels[state]);
        };
        const commentCard = requireElement<HTMLElement>("[data-comment-card]");
        const visibleCommentProjections = (): readonly ProjectedCommentThread[] => {
          const showResolved = requireElement<HTMLInputElement>("[data-show-resolved]").checked;
          return projectedComments.filter(
            (projection) => showResolved || !projection.thread.resolved,
          );
        };
        const findActiveCommentAnchor = (): HTMLElement | undefined =>
          [...document.querySelectorAll<HTMLElement>("[data-comment-bubble]")].find(
            (element) =>
              element.dataset["commentBubble"] === activeThreadId &&
              element.dataset["commentSurface"] === activeCommentSurface,
          );
        const positionCommentCard = (): void => {
          if (!commentCard.matches(":popover-open")) return;
          if (matchMedia("(width <= 52rem)").matches) {
            commentCard.style.removeProperty("--comment-card-left");
            commentCard.style.removeProperty("--comment-card-top");
            return;
          }
          const anchor = activeCommentAnchor;
          if (anchor === undefined || !anchor.isConnected) return;
          const anchorRect = anchor.getBoundingClientRect();
          const cardRect = commentCard.getBoundingClientRect();
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
          const top = Math.max(
            gap,
            Math.min(innerHeight - cardRect.height - gap, anchorRect.top - 18),
          );
          commentCard.style.setProperty("--comment-card-left", `${left}px`);
          commentCard.style.setProperty("--comment-card-top", `${top}px`);
        };
        const renderActiveCommentCard = (anchor?: HTMLElement): void => {
          if (activeThreadId === undefined) return;
          const thread = comments.threads.find((item) => item.id === activeThreadId);
          if (thread === undefined) {
            if (commentCard.matches(":popover-open")) commentCard.hidePopover();
            activeThreadId = undefined;
            return;
          }
          activeCommentAnchor = anchor ?? findActiveCommentAnchor() ?? activeCommentAnchor;
          commentCard.innerHTML = commentHtml(thread, permissions.includes("manage-comments"));
          bindCommentActions();
          if (!commentCard.matches(":popover-open")) commentCard.showPopover();
          document.querySelectorAll<HTMLElement>("[data-comment-bubble]").forEach((bubble) => {
            bubble.classList.toggle(
              "is-active",
              bubble.dataset["commentBubble"] === activeThreadId,
            );
          });
          requestAnimationFrame(positionCommentCard);
        };
        const renderCommentProjections = (): void => {
          const visible = visibleCommentProjections();
          updateEditorCommentDecorations(editor, visible);
          const preview = requireElement<HTMLElement>("[data-preview]");
          renderPreviewCommentBubbles(preview, visible);
          renderPreviewCommentComposer(preview, previewSelection);
          activeCommentAnchor = findActiveCommentAnchor() ?? activeCommentAnchor;
          if (commentCard.matches(":popover-open")) renderActiveCommentCard();
        };
        const renderOrphanedComments = (): void => {
          const orphaned = projectedComments.filter(
            (projection) =>
              projection.orphaned &&
              (!projection.thread.resolved ||
                requireElement<HTMLInputElement>("[data-show-resolved]").checked),
          );
          const container = requireElement<HTMLElement>("[data-orphaned-comments]");
          container.hidden = orphaned.length === 0;
          container.innerHTML =
            orphaned.length === 0
              ? ""
              : `<p><b>${orphaned.length} orphaned ${orphaned.length === 1 ? "thread" : "threads"}</b><br>Its original text was removed.</p>${orphaned
                  .map((projection) => {
                    const message = projection.thread.messages[0];
                    return `<button type="button" data-comment-bubble="${projection.thread.id}" data-comment-surface="preview"><span>${escapeHtml(message?.authorDisplayName ?? "Unknown author")}</span>${escapeHtml(message?.body ?? "Open comment")}</button>`;
                  })
                  .join("")}`;
        };
        const refreshCommentProjections = (): void => {
          const generation = ++commentProjectionGeneration;
          runUi(
            Effect.forEach(comments.threads, (thread) =>
              thread.anchor.orphaned
                ? Effect.succeed({
                    end: thread.anchor.originalEnd,
                    orphaned: true,
                    start: thread.anchor.originalStart,
                    thread,
                  } satisfies ProjectedCommentThread)
                : resolveCommentAnchor(yDocument, yBody, thread.anchor).pipe(
                    Effect.map(
                      (resolved) => ({ ...resolved, thread }) satisfies ProjectedCommentThread,
                    ),
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
                  if (generation !== commentProjectionGeneration) return;
                  projectedComments = next;
                  renderOrphanedComments();
                  renderCommentProjections();
                }),
              ),
            ),
          );
        };
        const renderComments = (): void => {
          const openCount = comments.threads.filter((thread) => !thread.resolved).length;
          requireElement<HTMLElement>("[data-comment-count]").textContent = String(openCount);
          requireElement<HTMLButtonElement>("[data-comment-new]").disabled =
            !permissions.includes("comment");
          refreshCommentProjections();
        };
        const bindCommentActions = (): void => {
          document.querySelectorAll<HTMLButtonElement>("[data-comment-close]").forEach((button) => {
            button.addEventListener("click", () => {
              if (commentCard.matches(":popover-open")) commentCard.hidePopover();
              activeThreadId = undefined;
              activeCommentAnchor = undefined;
              document
                .querySelectorAll(".segment-comment-bubble.is-active")
                .forEach((bubble) => bubble.classList.remove("is-active"));
            });
          });
          document.querySelectorAll<HTMLButtonElement>("[data-reply-thread]").forEach((button) => {
            button.addEventListener("click", () => {
              const thread = comments.threads.find(
                (item) => item.id === button.dataset["replyThread"],
              );
              const parent = thread?.messages.at(-1);
              const body = window.prompt("Reply");
              if (
                thread === undefined ||
                parent === undefined ||
                body === null ||
                body.trim() === ""
              )
                return;
              runUi(
                api
                  .reply(documentId, thread.id, parent.id, body, shared ? guestName() : "Owner")
                  .pipe(
                    Effect.tap((next) =>
                      Effect.sync(() => {
                        comments = next;
                        renderComments();
                      }),
                    ),
                    Effect.catchAll(showToastError),
                  ),
              );
            });
          });
          document.querySelectorAll<HTMLButtonElement>("[data-edit-message]").forEach((button) => {
            button.addEventListener("click", () => {
              const [threadId, messageId] = (button.dataset["editMessage"] ?? "").split(":");
              const message = comments.threads
                .find((thread) => thread.id === threadId)
                ?.messages.find((item) => item.id === messageId);
              if (threadId === undefined || messageId === undefined || message === undefined)
                return;
              const body = window.prompt("Edit comment", message.body);
              if (body === null || body.trim() === "") return;
              runUi(
                api.editMessage(documentId, threadId, messageId, body).pipe(
                  Effect.tap((next) =>
                    Effect.sync(() => {
                      comments = next;
                      renderComments();
                    }),
                  ),
                  Effect.catchAll(showToastError),
                ),
              );
            });
          });
          document
            .querySelectorAll<HTMLButtonElement>("[data-delete-message]")
            .forEach((button) => {
              button.addEventListener("click", () => {
                const [threadId, messageId] = (button.dataset["deleteMessage"] ?? "").split(":");
                if (
                  threadId === undefined ||
                  messageId === undefined ||
                  !window.confirm("Delete this comment message?")
                )
                  return;
                runUi(
                  api.deleteMessage(documentId, threadId, messageId).pipe(
                    Effect.tap((next) =>
                      Effect.sync(() => {
                        comments = next;
                        renderComments();
                      }),
                    ),
                    Effect.catchAll(showToastError),
                  ),
                );
              });
            });
          document.querySelectorAll<HTMLButtonElement>("[data-delete-thread]").forEach((button) => {
            button.addEventListener("click", () => {
              const threadId = button.dataset["deleteThread"];
              if (threadId === undefined || !window.confirm("Delete this comment thread?")) return;
              runUi(
                api.deleteThread(documentId, threadId).pipe(
                  Effect.tap((next) =>
                    Effect.sync(() => {
                      comments = next;
                      renderComments();
                    }),
                  ),
                  Effect.catchAll(showToastError),
                ),
              );
            });
          });
          document
            .querySelectorAll<HTMLButtonElement>("[data-resolve-thread]")
            .forEach((button) => {
              button.addEventListener("click", () => {
                const thread = comments.threads.find(
                  (item) => item.id === button.dataset["resolveThread"],
                );
                if (thread === undefined) return;
                runUi(
                  api.resolveThread(documentId, thread.id, !thread.resolved).pipe(
                    Effect.tap((next) =>
                      Effect.sync(() => {
                        comments = next;
                        renderComments();
                      }),
                    ),
                    Effect.catchAll(showToastError),
                  ),
                );
              });
            });
        };

        updateMetadataView(metadata);
        renderComments();
        requireElement<HTMLInputElement>("[data-show-resolved]").addEventListener(
          "change",
          renderComments,
        );
        const createCommentOnRange = (range: PreviewSourceRange): void => {
          if (!permissions.includes("comment")) return;
          if (range.start < 0 || range.end > yBody.length || range.end <= range.start) {
            showToast("Select text before opening a comment.", "error");
            return;
          }
          if (range.end - range.start > 20_000) {
            showToast("Select a smaller section to comment on.", "error");
            return;
          }
          const body = window.prompt("Comment on this selection");
          if (body === null || body.trim() === "") return;
          runUi(
            createCommentAnchor(yBody, range.start, range.end).pipe(
              Effect.flatMap((anchor) =>
                api.createThread(documentId, anchor, body, shared ? guestName() : "Owner"),
              ),
              Effect.tap((next) =>
                Effect.sync(() => {
                  comments = next;
                  previewSelection = undefined;
                  document.getSelection()?.removeAllRanges();
                  renderComments();
                  const menu = requireElement<HTMLElement>("#comment-menu");
                  if (menu.matches(":popover-open")) menu.hidePopover();
                }),
              ),
              Effect.catchAll((failure) => Effect.sync(() => showToast(String(failure), "error"))),
            ),
          );
        };
        const commentOnSelection = (): void => {
          const previewRange = selectedPreviewSourceRange(
            requireElement<HTMLElement>("[data-preview]"),
          );
          const selection = editor.state.selection.main;
          const sourceRange = selection.empty
            ? undefined
            : { end: selection.to, start: selection.from };
          const range = previewRange ?? previewSelection ?? sourceRange;
          if (range === undefined) {
            showToast("Select Markdown or rendered text before commenting.", "error");
            return;
          }
          createCommentOnRange(range);
        };
        requireElement<HTMLButtonElement>("[data-comment-new]").addEventListener(
          "click",
          commentOnSelection,
        );
        const previewElement = requireElement<HTMLElement>("[data-preview]");
        const updatePreviewSelection = (): void => {
          window.setTimeout(() => {
            previewSelection = selectedPreviewSourceRange(previewElement);
            renderPreviewCommentComposer(previewElement, previewSelection);
          });
        };
        previewElement.addEventListener("pointerup", updatePreviewSelection);
        previewElement.addEventListener("keyup", updatePreviewSelection);
        const handleCommentBubbleClick = (event: Event): void => {
          const target = event.target;
          if (!(target instanceof Element)) return;
          const composer = target.closest<HTMLElement>("[data-comment-composer]");
          if (composer !== null) {
            const start = Number(composer.dataset["sourceStart"]);
            const end = Number(composer.dataset["sourceEnd"]);
            if (Number.isSafeInteger(start) && Number.isSafeInteger(end)) {
              createCommentOnRange({ end, start });
            }
            return;
          }
          const bubble = target.closest<HTMLElement>("[data-comment-bubble]");
          const threadId = bubble?.dataset["commentBubble"];
          if (bubble === null || threadId === undefined) return;
          activeThreadId = threadId;
          activeCommentSurface =
            bubble.dataset["commentSurface"] === "source" ? "source" : "preview";
          activeCommentAnchor = bubble;
          renderActiveCommentCard(bubble);
        };
        const handleCommentCardToggle = (): void => {
          if (commentCard.matches(":popover-open")) return;
          activeCommentAnchor = undefined;
          document
            .querySelectorAll(".segment-comment-bubble.is-active")
            .forEach((bubble) => bubble.classList.remove("is-active"));
        };
        app.addEventListener("click", handleCommentBubbleClick);
        commentCard.addEventListener("toggle", handleCommentCardToggle);
        document.addEventListener("scroll", positionCommentCard, true);
        window.addEventListener("resize", positionCommentCard);
        requireElement<HTMLInputElement>("[data-attachment]").addEventListener(
          "change",
          (event) => {
            const input = event.currentTarget;
            if (!(input instanceof HTMLInputElement) || input.files?.[0] === undefined) return;
            const file = input.files[0];
            runUi(
              api.uploadAttachment(documentId, file).pipe(
                Effect.tap((attachment) =>
                  Effect.sync(() => {
                    const selection = editor.state.selection.main;
                    const label = attachment.filename.replaceAll("[", "").replaceAll("]", "");
                    const insertedMarkdown = attachment.mediaType.startsWith("image/")
                      ? `![${label}](${attachment.url})`
                      : `[${label}](${attachment.url})`;
                    editor.dispatch({
                      changes: {
                        from: selection.from,
                        insert: insertedMarkdown,
                        to: selection.to,
                      },
                      selection: { anchor: selection.from + insertedMarkdown.length },
                    });
                    input.value = "";
                    showToast("Attachment uploaded and linked.", "success");
                  }),
                ),
                Effect.catchAll(showToastError),
              ),
            );
          },
        );
        requireElement<HTMLInputElement>("[data-title]").addEventListener("change", (event) => {
          const input = event.currentTarget;
          if (!(input instanceof HTMLInputElement) || !permissions.includes("edit-metadata"))
            return;
          runUi(
            api
              .updateMetadata(documentId, {
                expectedRevision: metadata.headRevision,
                title: input.value,
              })
              .pipe(
                Effect.tap((next) => Effect.sync(() => updateMetadataView(next))),
                Effect.catchAll(showToastError),
              ),
          );
        });
        requireElement<HTMLSelectElement>("[data-state]").addEventListener("change", (event) => {
          const select = event.currentTarget;
          if (!(select instanceof HTMLSelectElement)) return;
          runUi(
            api
              .updateMetadata(documentId, {
                expectedRevision: metadata.headRevision,
                lifecycleState: select.value,
              })
              .pipe(
                Effect.tap((next) => Effect.sync(() => updateMetadataView(next))),
                Effect.catchAll(showToastError),
              ),
          );
        });
        requireElement<HTMLSelectElement>("[data-visibility]").addEventListener(
          "change",
          (event) => {
            const select = event.currentTarget;
            if (!(select instanceof HTMLSelectElement)) return;
            const visibility = select.value === "public" ? "public" : "workspace";
            const confirmed =
              visibility !== "public" ||
              metadata.sensitivity !== "confidential" ||
              window.confirm("Publish confidential metadata as public?");
            if (!confirmed) {
              select.value = metadata.visibility;
              return;
            }
            runUi(
              api
                .updateMetadata(documentId, {
                  confirmConfidentialPublic: visibility === "public",
                  expectedRevision: metadata.headRevision,
                  visibility,
                })
                .pipe(
                  Effect.tap((next) => Effect.sync(() => updateMetadataView(next))),
                  Effect.catchAll(showToastError),
                ),
            );
          },
        );
        requireElement<HTMLSelectElement>("[data-sensitivity]").addEventListener(
          "change",
          (event) => {
            const select = event.currentTarget;
            if (!(select instanceof HTMLSelectElement)) return;
            runUi(
              api
                .updateMetadata(documentId, {
                  expectedRevision: metadata.headRevision,
                  sensitivity: select.value === "confidential" ? "confidential" : "normal",
                })
                .pipe(
                  Effect.tap((next) => Effect.sync(() => updateMetadataView(next))),
                  Effect.catchAll(showToastError),
                ),
            );
          },
        );
        requireElement<HTMLInputElement>("[data-labels]").addEventListener("change", (event) => {
          const input = event.currentTarget;
          if (!(input instanceof HTMLInputElement)) return;
          runUi(
            api
              .updateMetadata(documentId, {
                expectedRevision: metadata.headRevision,
                labels: input.value
                  .split(",")
                  .map((label) => label.trim())
                  .filter(Boolean),
              })
              .pipe(
                Effect.tap((next) => Effect.sync(() => updateMetadataView(next))),
                Effect.catchAll(showToastError),
              ),
          );
        });
        document.querySelector<HTMLButtonElement>("[data-share]")?.addEventListener("click", () => {
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
          runUi(
            api.updateShare(documentId, selected, metadata.headRevision).pipe(
              Effect.tap((response) =>
                Effect.gen(function* () {
                  metadata = {
                    ...metadata,
                    sharing: response.policy,
                    headRevision: metadata.headRevision + 1,
                  };
                  if (response.capabilityUrl !== undefined) {
                    const capabilityUrl = response.capabilityUrl;
                    yield* Effect.tryPromise({
                      catch: () => undefined,
                      try: () => navigator.clipboard.writeText(capabilityUrl),
                    }).pipe(Effect.ignore);
                    showToast("Capability URL copied. It will not be shown again.", "success");
                  } else {
                    showToast("Share access updated.", "success");
                  }
                }),
              ),
              Effect.catchAll(showToastError),
            ),
          );
        });
        document
          .querySelector<HTMLButtonElement>("[data-publish]")
          ?.addEventListener("click", () => {
            runUi(
              api.publish(documentId).pipe(
                Effect.tap((next) =>
                  Effect.sync(() => {
                    updateMetadataView(next);
                    showToast("Revision published.", "success");
                  }),
                ),
                Effect.catchAll(showToastError),
              ),
            );
          });
        const previewToggle = requireElement<HTMLButtonElement>("[data-preview-toggle]");
        const setPreviewOpen = (open: boolean): void => {
          app.classList.toggle("preview-open", open);
          previewToggle.setAttribute("aria-pressed", String(open));
        };
        previewToggle.addEventListener("click", () =>
          setPreviewOpen(!app.classList.contains("preview-open")),
        );
        requireElement<HTMLButtonElement>("[data-preview-close]").addEventListener("click", () =>
          setPreviewOpen(false),
        );

        runUi(
          makeCollaborationClient(
            documentId,
            yDocument,
            capabilityToken,
            shared ? guestName() : undefined,
            {
              onComments: (next) => {
                comments = next;
                renderComments();
              },
              onError: (message) => showToast(message, "error"),
              onMetadata: updateMetadataView,
              onPermissions: updatePermissions,
              onPresence: (presence) => {
                remoteParticipants.set(presence.participantId, presence);
                renderParticipants(remoteParticipants);
              },
              onState: updateConnectionState,
            },
          ).pipe(
            Effect.tap((created) =>
              Effect.sync(() => {
                client = created;
              }),
            ),
          ),
        );

        cleanup = Effect.gen(function* () {
          if (client !== undefined) yield* client.close;
          yield* Effect.sync(() => {
            yBody.unobserve(updatePreview);
            previewElement.removeEventListener("pointerup", updatePreviewSelection);
            previewElement.removeEventListener("keyup", updatePreviewSelection);
            app.removeEventListener("click", handleCommentBubbleClick);
            commentCard.removeEventListener("toggle", handleCommentCardToggle);
            document.removeEventListener("scroll", positionCommentCard, true);
            window.removeEventListener("resize", positionCommentCard);
            editor.destroy();
            awareness.destroy();
            yDocument.destroy();
          });
        });
      }),
    ),
  );
}

function commentHtml(thread: CommentThreadDto, canManage: boolean): string {
  const root = thread.messages[0];
  const replies = thread.messages.slice(1);
  return `<section class="comment-thread ${thread.resolved ? "is-resolved" : ""}">
    <div class="comment-thread__heading"><span>Thread</span><button class="icon-button" type="button" data-comment-close aria-label="Close comment thread">×</button></div>
    <blockquote>${escapeHtml(thread.anchor.quote || "Orphaned selection")}</blockquote>
    ${root === undefined ? "" : messageHtml(thread.id, root.id, root.authorDisplayName, root.body)}
    ${replies.map((message) => messageHtml(thread.id, message.id, message.authorDisplayName, message.body)).join("")}
    <div class="comment-actions"><button type="button" data-reply-thread="${thread.id}">Reply</button><button type="button" data-resolve-thread="${thread.id}">${thread.resolved ? "Reopen" : "Resolve"}</button>${canManage ? `<button type="button" data-delete-thread="${thread.id}">Delete thread</button>` : ""}</div>
  </section>`;
}

function messageHtml(threadId: string, messageId: string, author: string, body: string): string {
  const key = `${threadId}:${messageId}`;
  return `<div class="comment-message"><b>${escapeHtml(author)}</b><p>${escapeHtml(body)}</p><span><button type="button" data-edit-message="${key}">Edit</button><button type="button" data-delete-message="${key}">Delete</button></span></div>`;
}

function renderMermaid(): Effect.Effect<void> {
  return Effect.tryPromise({
    catch: () => undefined,
    try: async () => {
      const diagrams = [...document.querySelectorAll<HTMLElement>("[data-mermaid]")];
      await Promise.all(
        diagrams.map(async (diagram, index) => {
          const code = diagram.querySelector("code")?.textContent ?? "";
          const rendered = await mermaid.render(`jot-mermaid-${index}-${Date.now()}`, code);
          diagram.innerHTML = `<div class="mermaid-viewport">${rendered.svg}</div><div class="jot-mermaid__controls"><button type="button" data-mermaid-zoom-in aria-label="Zoom in">+</button><button type="button" data-mermaid-zoom-out aria-label="Zoom out">−</button><button type="button" data-mermaid-reset>Reset</button></div>`;
          const viewport = diagram.querySelector<HTMLElement>(".mermaid-viewport");
          if (viewport === null) return;
          let scale = 1;
          let offsetX = 0;
          let offsetY = 0;
          let dragStart: { readonly x: number; readonly y: number } | undefined;
          const applyTransform = (): void => {
            viewport.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(${scale})`;
          };
          diagram.querySelector("[data-mermaid-zoom-in]")?.addEventListener("click", () => {
            scale = Math.min(4, scale + 0.2);
            applyTransform();
          });
          diagram.querySelector("[data-mermaid-zoom-out]")?.addEventListener("click", () => {
            scale = Math.max(0.4, scale - 0.2);
            applyTransform();
          });
          diagram.querySelector("[data-mermaid-reset]")?.addEventListener("click", () => {
            scale = 1;
            offsetX = 0;
            offsetY = 0;
            applyTransform();
          });
          viewport.addEventListener("pointerdown", (event) => {
            dragStart = { x: event.clientX - offsetX, y: event.clientY - offsetY };
            viewport.setPointerCapture(event.pointerId);
          });
          viewport.addEventListener("pointermove", (event) => {
            if (dragStart === undefined) return;
            offsetX = event.clientX - dragStart.x;
            offsetY = event.clientY - dragStart.y;
            applyTransform();
          });
          viewport.addEventListener("pointerup", (event) => {
            dragStart = undefined;
            viewport.releasePointerCapture(event.pointerId);
          });
        }),
      );
    },
  }).pipe(Effect.ignore);
}

function renderParticipants(participants: ReadonlyMap<string, PresenceDto>): void {
  participantsElement.innerHTML = [...participants.values()]
    .slice(0, 6)
    .map(
      (participant) =>
        `<span class="participant" style="--participant:${escapeHtml(participant.color)}" title="${escapeHtml(participant.displayName)}">${escapeHtml(participant.displayName.slice(0, 1).toUpperCase())}</span>`,
    )
    .join("");
}

function installThemeControl(): void {
  const button = requireElement<HTMLButtonElement>("[data-theme-toggle]");
  const stored = localStorage.getItem("jot-theme");
  const initial =
    stored === "light" || stored === "dark"
      ? stored
      : matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";

  const setTheme = (theme: "dark" | "light"): void => {
    document.documentElement.dataset["theme"] = theme;
    button.setAttribute("aria-label", `Switch to ${theme === "dark" ? "light" : "dark"} theme`);
  };

  setTheme(initial);
  button.addEventListener("click", (event) => {
    // A double-click emits two click events. Ignore the duplicate instead of toggling twice.
    if (event.detail > 1) return;
    const next = document.documentElement.dataset["theme"] === "dark" ? "light" : "dark";
    localStorage.setItem("jot-theme", next);
    setTheme(next);
  });
}

function guestName(): string {
  const existing = localStorage.getItem("jot-guest-name");
  if (existing !== null && existing.trim() !== "") return existing;
  const entered = window.prompt("Your display name")?.trim() || "Guest";
  localStorage.setItem("jot-guest-name", entered);
  return entered;
}

function setApiStatus(state: string, label: string): void {
  document.documentElement.dataset["api"] = state;
  statusElement.textContent = label;
}

function showFatal(error: ApiError): Effect.Effect<void> {
  return Effect.sync(() => {
    setApiStatus("unavailable", "Authority unavailable");
    app.className = "fatal-layout";
    app.innerHTML = `<section><p class="eyebrow">Runtime failure</p><h1>Jot could not open.</h1><p>${escapeHtml(error.message)}</p><button class="primary-button" onclick="location.reload()">Try again</button></section>`;
  });
}

function showToastError(error: ApiError): Effect.Effect<void> {
  return Effect.sync(() => showToast(error.message, "error"));
}

function showToast(message: string, kind: "error" | "success"): void {
  const toast = document.createElement("div");
  toast.className = `toast toast--${kind}`;
  toast.textContent = message;
  toastRegion.append(toast);
  window.setTimeout(() => toast.remove(), 4_000);
}

function runUi<A, E>(effect: Effect.Effect<A, E>): void {
  Effect.runFork(effect);
}

function requireElement<ElementType extends Element>(selector: string): ElementType {
  const element = document.querySelector<ElementType>(selector);
  if (element === null) {
    throw new Error(`Missing required element: ${selector}`);
  }
  return element;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(value));
}

function colorFor(value: string): string {
  let hash = 0;
  for (const character of value) {
    hash = (hash * 31 + (character.codePointAt(0) ?? 0)) | 0;
  }
  return `hsl(${Math.abs(hash) % 360} 58% 46%)`;
}

window.addEventListener("beforeunload", () => Effect.runFork(cleanup));
