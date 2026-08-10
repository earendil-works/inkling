import { useEffect, useRef, useState } from "react";
import { Effect } from "effect";

import type { DocumentHistoryVersionDto, DocumentResponse } from "@earendil-works/inkling-protocol";

import type { ApiClientService, ApiError } from "../api.ts";
import { useAppContext } from "../app-context.tsx";
import type { CollaborationClientError } from "../collaboration.ts";
import { useEffectAction, useEffectQuery } from "../effect-hooks.ts";
import { historyChangeRanges } from "../history-diff.ts";
import type { HistoryChangeRange } from "../history-diff.ts";
import { Button } from "./button.tsx";
import { ConfirmationDialog } from "./confirmation-dialog.tsx";
import { FormError } from "./form-error.tsx";
import styles from "./history-control.module.css";

export interface HistoryPreview {
  readonly changes: readonly HistoryChangeRange[];
  readonly document: DocumentResponse;
}

export interface HistoryControlProps {
  readonly api: ApiClientService;
  readonly beforeOpen: () => Effect.Effect<void, CollaborationClientError>;
  readonly canRestore: boolean;
  readonly currentRevision: number;
  readonly documentId: string;
  readonly onPreview: (preview: HistoryPreview | undefined) => void;
  readonly onRestored: (document: DocumentResponse) => void;
}

export function HistoryControl({
  api,
  beforeOpen,
  canRestore,
  currentRevision,
  documentId,
  onPreview,
  onRestored,
}: HistoryControlProps): React.JSX.Element {
  const { showToast } = useAppContext();
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const revisionCacheRef = useRef(new Map<number, DocumentResponse>());
  const [open, setOpen] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [restoreCandidate, setRestoreCandidate] = useState<DocumentHistoryVersionDto>();
  const historyQuery = useEffectQuery(
    open
      ? beforeOpen().pipe(Effect.zipRight(api.listDocumentHistory(documentId)))
      : Effect.succeed(undefined),
    `document-history:${documentId}:${open ? "open" : "closed"}`,
  );
  const previewAction = useEffectAction<
    { readonly previousRevision: number | undefined; readonly revision: number },
    HistoryPreview,
    ApiError
  >(({ previousRevision, revision }) =>
    Effect.gen(function* () {
      const document = yield* loadRevision(api, documentId, revision, revisionCacheRef.current);
      if (previousRevision === undefined) return { changes: [], document };
      const previous = yield* loadRevision(
        api,
        documentId,
        previousRevision,
        revisionCacheRef.current,
      );
      return { changes: historyChangeRanges(previous.body, document.body), document };
    }),
  );
  const restoreAction = useEffectAction<
    { readonly expectedRevision: number; readonly revision: number },
    DocumentResponse,
    ApiError
  >(({ expectedRevision, revision }) =>
    api.restoreDocumentHistoryRevision(documentId, revision, expectedRevision),
  );
  const versions = historyQuery.state.data?.versions ?? [];
  const selected = versions[selectedIndex];

  useEffect(() => {
    if (!open) return;
    const closeFromOutside = (event: PointerEvent): void => {
      const target = event.target;
      if (target instanceof Element && target.closest("dialog") !== null) return;
      if (!detailsRef.current?.contains(target as Node)) close();
    };
    const closeFromEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || document.querySelector("dialog[open]") !== null) return;
      close();
      detailsRef.current?.querySelector<HTMLElement>("summary")?.focus();
    };
    document.addEventListener("pointerdown", closeFromOutside);
    document.addEventListener("keydown", closeFromEscape);
    return () => {
      document.removeEventListener("pointerdown", closeFromOutside);
      document.removeEventListener("keydown", closeFromEscape);
    };
  }, [open]);

  useEffect(() => {
    if (!open || versions.length === 0) return;
    setSelectedIndex(versions.length - 1);
    onPreview(undefined);
  }, [historyQuery.state.data, open]);

  const close = (): void => {
    detailsRef.current?.removeAttribute("open");
    setOpen(false);
    setRestoreCandidate(undefined);
    previewAction.reset();
    onPreview(undefined);
  };
  const selectVersion = (index: number): void => {
    const version = versions[index];
    if (version === undefined) return;
    setSelectedIndex(index);
    if (version.revision === currentRevision) {
      previewAction.reset();
      onPreview(undefined);
      return;
    }
    previewAction.execute(
      { previousRevision: versions[index - 1]?.revision, revision: version.revision },
      {
        onFailure: () => onPreview(undefined),
        onSuccess: onPreview,
      },
    );
  };

  return (
    <>
      <details
        className={styles["control"]}
        onToggle={(event) => {
          const nextOpen = event.currentTarget.open;
          setOpen(nextOpen);
          if (!nextOpen) onPreview(undefined);
        }}
        ref={detailsRef}
      >
        <summary aria-haspopup="true" data-history-toggle="">
          History
        </summary>
        <section aria-label="Document history" className={styles["panel"]} data-history-dropdown="">
          <header className={styles["heading"]}>
            <div>
              <p>Recorded changes</p>
              <h2>Version history</h2>
            </div>
            <Button aria-label="Close version history" onClick={close} variant="icon">
              ×
            </Button>
          </header>

          {historyQuery.state.status === "loading" && versions.length === 0 ? (
            <p className={styles["empty"]}>Saving and loading history…</p>
          ) : versions.length === 0 ? (
            <p className={styles["empty"]}>No retained versions are available yet.</p>
          ) : (
            <>
              <div className={styles["timeline"]}>
                <input
                  aria-label="Document revision"
                  data-history-slider=""
                  max={versions.length - 1}
                  min={0}
                  onChange={(event) => selectVersion(Number(event.currentTarget.value))}
                  step={1}
                  type="range"
                  value={selectedIndex}
                />
                <div aria-hidden="true" className={styles["ends"]}>
                  <span>Oldest</span>
                  <span>Current</span>
                </div>
              </div>

              {selected === undefined ? null : (
                <article className={styles["version"]} data-history-revision={selected.revision}>
                  <div className={styles["revisionLine"]}>
                    <output>Revision {selected.revision}</output>
                    {selected.revision === currentRevision ? <span>Current</span> : null}
                  </div>
                  <strong>{versionLabel(selected)}</strong>
                  <p>{versionAttribution(selected)}</p>
                  {selected.revision === currentRevision ? (
                    <small>The editor and preview show this version.</small>
                  ) : previewAction.state.pending ? (
                    <small>Loading this revision into the editor and preview…</small>
                  ) : (
                    <small>Changed lines briefly pulse in the editor and preview.</small>
                  )}
                </article>
              )}

              <Button
                data-restore-history=""
                disabled={
                  !canRestore ||
                  selected === undefined ||
                  selected.revision === currentRevision ||
                  previewAction.state.pending
                }
                onClick={() => setRestoreCandidate(selected)}
                variant="primary"
              >
                Restore this version
              </Button>
            </>
          )}
          <FormError>
            {historyQuery.state.status === "failure"
              ? historyQuery.state.error.message
              : previewAction.state.error?.message}
          </FormError>
        </section>
      </details>

      <ConfirmationDialog
        confirmLabel="Restore version"
        description={
          restoreCandidate === undefined
            ? "The selected document contents will be restored as a new revision."
            : `Revision ${restoreCandidate.revision} will become a new revision. Current sharing, publication, and comments will be preserved.`
        }
        onCancel={() => setRestoreCandidate(undefined)}
        onConfirm={() => {
          const candidate = restoreCandidate;
          if (candidate === undefined) return;
          restoreAction.execute(
            { expectedRevision: currentRevision, revision: candidate.revision },
            {
              onFailure: (error) => showToast(error.message, "error"),
              onSuccess: (document) => {
                setRestoreCandidate(undefined);
                onRestored(document);
                close();
                showToast(`Restored revision ${candidate.revision}.`, "success");
              },
            },
          );
        }}
        open={restoreCandidate !== undefined}
        pending={restoreAction.state.pending}
        title="Restore these document contents?"
      />
    </>
  );
}

function loadRevision(
  api: ApiClientService,
  documentId: string,
  revision: number,
  cache: Map<number, DocumentResponse>,
): Effect.Effect<DocumentResponse, ApiError> {
  const cached = cache.get(revision);
  if (cached !== undefined) return Effect.succeed(cached);
  return api
    .readDocumentHistoryRevision(documentId, revision)
    .pipe(Effect.tap((document) => Effect.sync(() => cache.set(revision, document))));
}

function versionLabel(version: DocumentHistoryVersionDto): string {
  switch (version.kind) {
    case "snapshot":
      return "History begins";
    case "body-update":
      return version.source === "collaboration" ? "Edited document" : "Replaced document text";
    case "comment-event":
      return "Updated comments";
    case "metadata-event":
      return "Changed document details";
    case "publication-event":
      return "Changed publication";
    case "sharing-event":
      return "Changed sharing";
  }
}

function versionAttribution(version: DocumentHistoryVersionDto): string {
  const actor = version.actor?.displayName ?? version.actor?.id;
  const timestamp =
    version.occurredAt === undefined
      ? undefined
      : new Intl.DateTimeFormat(undefined, {
          dateStyle: "medium",
          timeStyle: "short",
        }).format(new Date(version.occurredAt));
  return [actor, timestamp].filter(Boolean).join(" · ") || "Recorded version";
}
