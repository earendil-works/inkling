import { useEffect, useState } from "react";

import {
  ArrowBackIcon,
  DeleteIcon,
  EditIcon,
  RestoreFromTrashIcon,
} from "@earendil-works/elanor-icons-react";
import { Button, Container, Layout, Page, PageHeader } from "@earendil-works/elanor-react";
import { documentTrashExpiresAt } from "@earendil-works/inkling-core";
import type { CatalogResponse, DocumentSummary } from "@earendil-works/inkling-protocol";

import type { ApiClientService, ApiError } from "./api.ts";
import { useAppContext, useCurrentUrl } from "./app-context.tsx";
import { documentFolio, documentHref, formatDate, formatLocalDate } from "./ui.ts";
import { ButtonLink } from "./components/button-link.tsx";
import { ConfirmationDialog } from "./components/confirmation-dialog.tsx";
import { EmptyMessage } from "./components/empty-message.tsx";
import { useEffectAction } from "./effect-hooks.ts";
import { atCurrentRevision } from "./trash-actions.ts";
import type { TrashMutation } from "./trash-actions.ts";
import { useHydrated } from "./use-hydrated.ts";
import styles from "./trash-screen.module.css";
import workspaceStyles from "./workspace.module.css";

export interface TrashScreenProps {
  readonly api: ApiClientService;
  /** Administrators delete any document permanently; members only their personal ones. */
  readonly canDeletePermanently: boolean;
  readonly initialCatalog: CatalogResponse;
}

export function TrashScreen({
  api,
  canDeletePermanently,
  initialCatalog,
}: TrashScreenProps): React.JSX.Element {
  const { showToast } = useAppContext();
  const { search } = useCurrentUrl();
  const formatDeletionDate = useHydrated() ? formatLocalDate : formatDate;
  const [catalog, setCatalog] = useState(initialCatalog);
  const [permanentCandidate, setPermanentCandidate] = useState<DocumentSummary>();
  const restoreDocument = useEffectAction<TrashMutation, unknown, ApiError>((mutation) =>
    atCurrentRevision(api, mutation, (revision) =>
      api.restoreDocument(mutation.documentId, revision),
    ),
  );
  const hardDeleteDocument = useEffectAction<TrashMutation, void, ApiError>((mutation) =>
    atCurrentRevision(api, mutation, (revision) =>
      api.hardDeleteDocument(mutation.documentId, revision),
    ),
  );

  useEffect(() => setCatalog(initialCatalog), [initialCatalog]);

  const removeFromList = (documentId: string): void =>
    setCatalog((current) => ({
      ...current,
      documents: current.documents.filter((document) => document.metadata.id !== documentId),
    }));

  return (
    <>
      <Layout.Main
        className={workspaceStyles["layout"]}
        data-trash=""
        data-workspace-layout=""
        id="app"
        tabIndex={-1}
      >
        <Container>
          <Page>
            <PageHeader.Root data-workspace-heading="">
              <PageHeader.Row>
                <PageHeader.Title level={1}>Trash</PageHeader.Title>
                <PageHeader.Actions>
                  <ButtonLink hierarchy="tertiary" iconStart={<ArrowBackIcon />} href="/">
                    All documents
                  </ButtonLink>
                </PageHeader.Actions>
              </PageHeader.Row>
              <PageHeader.Description className={workspaceStyles["description"]}>
                Documents are permanently deleted 30 days after they enter Trash.
              </PageHeader.Description>
            </PageHeader.Root>
            {catalog.documents.length === 0 ? (
              <section data-trash-catalog="">
                <EmptyMessage
                  description="Deleted documents will remain here for 30 days."
                  icon={DeleteIcon}
                  level={2}
                  title="Trash is empty."
                />
              </section>
            ) : (
              <section className={styles["catalog"]} data-trash-catalog="">
                {catalog.documents.map((document) => {
                  const metadata = document.metadata;
                  const expiresAt = documentTrashExpiresAt(metadata);
                  const busy = restoreDocument.state.pending || hardDeleteDocument.state.pending;
                  return (
                    <article
                      className={styles["row"]}
                      data-trash-document={metadata.id}
                      key={metadata.id}
                    >
                      <div className={styles["identity"]}>
                        <span className={styles["folio"]}>{documentFolio(metadata.rfcNumber)}</span>
                        <div className={styles["summary"]}>
                          <h2>
                            <a
                              href={documentHref(
                                metadata.id,
                                metadata.rfcNumber,
                                false,
                                "edit",
                                search,
                              )}
                            >
                              {metadata.title}
                            </a>
                          </h2>
                          <p>
                            {metadata.deletedAt === undefined
                              ? "Deletion date unavailable"
                              : `Deleted ${formatDeletionDate(metadata.deletedAt)}`}
                            {expiresAt === undefined
                              ? ""
                              : ` · Permanently deletes ${formatDeletionDate(expiresAt)}`}
                          </p>
                        </div>
                      </div>
                      <div className={styles["actions"]}>
                        <ButtonLink
                          data-edit-trashed-document={metadata.id}
                          density="compact"
                          hierarchy="secondary"
                          href={documentHref(
                            metadata.id,
                            metadata.rfcNumber,
                            false,
                            "edit",
                            search,
                          )}
                          iconStart={<EditIcon />}
                        >
                          Edit
                        </ButtonLink>
                        <Button
                          data-restore-document={metadata.id}
                          density="compact"
                          disabled={busy}
                          hierarchy="secondary"
                          iconStart={<RestoreFromTrashIcon />}
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
                        >
                          Restore
                        </Button>
                        {canDeletePermanently || metadata.personalOwner !== undefined ? (
                          <Button
                            data-hard-delete-document={metadata.id}
                            density="compact"
                            disabled={busy}
                            hierarchy="tertiary"
                            onClick={() => setPermanentCandidate(document)}
                            semantic="negative"
                          >
                            Delete forever
                          </Button>
                        ) : null}
                      </div>
                    </article>
                  );
                })}
              </section>
            )}
          </Page>
        </Container>
      </Layout.Main>
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
