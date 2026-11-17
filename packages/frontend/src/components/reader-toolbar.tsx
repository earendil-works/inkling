import { Effect } from "effect";

import { DownloadIcon, EditIcon } from "@earendil-works/elanor-icons-react";
import { Button } from "@earendil-works/elanor-react";
import type { DocumentResponse } from "@earendil-works/inkling-protocol";

import { useAppContext, useCurrentUrl } from "../app-context.tsx";
import { downloadDocument } from "../document-export.ts";
import type { DocumentExportFormat } from "../document-export.ts";
import { browserRuntime } from "../effect-runtime.ts";
import type { ReferenceResolutionRecord } from "../markdown.tsx";
import { documentHref } from "../ui.ts";
import { ButtonLink } from "./button-link.tsx";
import styles from "./reader.module.css";

export interface ReaderToolbarProps {
  readonly document: DocumentResponse;
  readonly publicDocument?: boolean | undefined;
  readonly references?: ReferenceResolutionRecord | undefined;
  readonly shared: boolean;
}

export function ReaderToolbar({
  document,
  publicDocument = false,
  references,
  shared,
}: ReaderToolbarProps): React.JSX.Element | null {
  const { metadata } = document;
  const { search } = useCurrentUrl();
  const { showToast } = useAppContext();
  const canEdit = !publicDocument && (!shared || metadata.sharing.access === "edit");
  // The reader shows a body for published revisions and personal drafts; trashed documents show none.
  const canDownload =
    metadata.deletedAt === undefined &&
    (metadata.publishedRevision !== undefined || metadata.personalOwner !== undefined);
  if (!canEdit && !canDownload) return null;

  const download = (format: DocumentExportFormat): void => {
    browserRuntime.runFork(
      downloadDocument(format, document, references).pipe(
        Effect.catchAll((error) => Effect.sync(() => showToast(error.message, "error"))),
      ),
    );
  };

  return (
    <nav aria-label="Document navigation" className={styles["toolbar"]}>
      {canDownload ? (
        <>
          <Button
            data-download-docx=""
            iconStart={<DownloadIcon />}
            onClick={() => download("docx")}
          >
            Download as .docx
          </Button>
          <Button data-download-pdf="" iconStart={<DownloadIcon />} onClick={() => download("pdf")}>
            Download as .pdf
          </Button>
        </>
      ) : null}
      {canEdit ? (
        <ButtonLink
          data-open-editor=""
          iconStart={<EditIcon />}
          href={documentHref(metadata.id, metadata.rfcNumber, shared, "edit", search)}
        >
          Edit
        </ButtonLink>
      ) : null}
    </nav>
  );
}
