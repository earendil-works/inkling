import { useEffect, useState } from "react";

import { documentTrashExpiresAt } from "@earendil-works/inkling-core";
import type { CatalogResponse, DocumentSummary } from "@earendil-works/inkling-protocol";

import type { ApiClientService, ApiError } from "./api.ts";
import { useAppContext } from "./app-context.tsx";
import { documentHref } from "./ui.ts";
import { ButtonLink } from "./components/button-link.tsx";
import { Button } from "./components/button.tsx";
import { ConfirmationDialog } from "./components/confirmation-dialog.tsx";
import { useEffectAction } from "./effect-hooks.ts";

export interface TrashScreenProps {
  readonly api: ApiClientService;
  readonly initialCatalog: CatalogResponse;
}

interface TrashMutation {
  readonly documentId: string;
  readonly expectedRevision: number;
}

export function TrashScreen({ api, initialCatalog }: TrashScreenProps): React.JSX.Element {
  const { showToast } = useAppContext();
  const [catalog, setCatalog] = useState(initialCatalog);
  const [permanentCandidate, setPermanentCandidate] = useState<DocumentSummary>();
  const restoreDocument = useEffectAction<TrashMutation, unknown, ApiError>(
    ({ documentId, expectedRevision }) => api.restoreDocument(documentId, expectedRevision),
  );
  const hardDeleteDocument = useEffectAction<TrashMutation, void, ApiError>(
    ({ documentId, expectedRevision }) => api.hardDeleteDocument(documentId, expectedRevision),
  );

  useEffect(() => setCatalog(initialCatalog), [initialCatalog]);

  const removeFromList = (documentId: string): void =>
    setCatalog((current) => ({
      ...current,
      documents: current.documents.filter((document) => document.metadata.id !== documentId),
    }));

  return (
    <>
      <main className="workspace-layout trash-layout" data-trash="" id="app" tabIndex={-1}>
        <section className="workspace-heading trash-heading">
          <div>
            <h1>Trash</h1>
            <p>Documents are permanently deleted 30 days after they enter Trash.</p>
          </div>
          <ButtonLink href="/" variant="toolbar">
            All documents
          </ButtonLink>
        </section>
        {catalog.documents.length === 0 ? (
          <section className="catalog" data-trash-catalog="">
            <div className="empty-state">
              <span>Ø</span>
              <h2>Trash is empty.</h2>
              <p>Deleted documents will remain here for 30 days.</p>
            </div>
          </section>
        ) : (
          <section className="trash-catalog" data-trash-catalog="">
            {catalog.documents.map((document) => {
              const metadata = document.metadata;
              const expiresAt = documentTrashExpiresAt(metadata);
              return (
                <article className="trash-row" data-trash-document={metadata.id} key={metadata.id}>
                  <div className="trash-row__identity">
                    <span className="folio">
                      {metadata.rfcNumber === undefined
                        ? "Note"
                        : `RFC ${String(metadata.rfcNumber).padStart(4, "0")}`}
                    </span>
                    <div>
                      <h2>
                        <a href={documentHref(metadata.id, metadata.rfcNumber, false, "edit")}>
                          {metadata.title}
                        </a>
                      </h2>
                      <p>
                        {metadata.deletedAt === undefined
                          ? "Deletion date unavailable"
                          : `Deleted ${formatDate(metadata.deletedAt)}`}
                        {expiresAt === undefined
                          ? ""
                          : ` · Permanently deletes ${formatDate(expiresAt)}`}
                      </p>
                    </div>
                  </div>
                  <div className="trash-row__actions">
                    <ButtonLink
                      data-edit-trashed-document={metadata.id}
                      href={documentHref(metadata.id, metadata.rfcNumber, false, "edit")}
                      variant="toolbar"
                    >
                      Edit
                    </ButtonLink>
                    <Button
                      data-restore-document={metadata.id}
                      disabled={restoreDocument.state.pending || hardDeleteDocument.state.pending}
                      onClick={() =>
                        restoreDocument.execute(
                          {
                            documentId: metadata.id,
                            expectedRevision: metadata.headRevision,
                          },
                          {
                            onFailure: (error) => showToast(error.message, "error"),
                            onSuccess: () => {
                              removeFromList(metadata.id);
                              showToast("Document restored.", "success");
                            },
                          },
                        )
                      }
                      variant="toolbar"
                    >
                      Restore
                    </Button>
                    <Button
                      className="trash-row__delete"
                      data-hard-delete-document={metadata.id}
                      disabled={restoreDocument.state.pending || hardDeleteDocument.state.pending}
                      onClick={() => setPermanentCandidate(document)}
                      variant="text"
                    >
                      Delete forever
                    </Button>
                  </div>
                </article>
              );
            })}
          </section>
        )}
      </main>
      <ConfirmationDialog
        confirmLabel="Delete forever"
        description={
          permanentCandidate === undefined
            ? "This cannot be undone."
            : `“${permanentCandidate.metadata.title}” and all of its attachments and comments will be permanently deleted. This cannot be undone.`
        }
        onCancel={() => setPermanentCandidate(undefined)}
        onConfirm={() => {
          const candidate = permanentCandidate;
          if (candidate === undefined) return;
          hardDeleteDocument.execute(
            {
              documentId: candidate.metadata.id,
              expectedRevision: candidate.metadata.headRevision,
            },
            {
              onFailure: (error) => {
                setPermanentCandidate(undefined);
                showToast(error.message, "error");
              },
              onSuccess: () => {
                removeFromList(candidate.metadata.id);
                setPermanentCandidate(undefined);
                showToast("Document permanently deleted.", "success");
              },
            },
          );
        }}
        open={permanentCandidate !== undefined}
        pending={hardDeleteDocument.state.pending}
        title="Permanently delete this document?"
        tone="danger"
      />
    </>
  );
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(value));
}
