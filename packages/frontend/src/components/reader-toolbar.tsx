import type { DocumentMetadataDto } from "@earendil-works/jot-protocol";

import { documentHref } from "../ui.ts";
import { ButtonLink } from "./button-link.tsx";

export interface ReaderToolbarProps {
  readonly metadata: DocumentMetadataDto;
  readonly shared: boolean;
}

export function ReaderToolbar({ metadata, shared }: ReaderToolbarProps): React.JSX.Element {
  const canEdit = !shared || metadata.sharing.access === "edit";

  return (
    <nav className="document-bar reader-toolbar" aria-label="Document navigation">
      <div className="document-identity">
        <span>
          {metadata.rfcNumber === undefined
            ? "Document"
            : `RFC ${String(metadata.rfcNumber).padStart(4, "0")}`}
        </span>
        <strong className="reader-toolbar__title">{metadata.title}</strong>
      </div>
      <div className="document-actions">
        <ButtonLink className="document-mode-link" href="/" variant="toolbar">
          All documents
        </ButtonLink>
        {canEdit ? (
          <ButtonLink
            className="document-mode-link"
            data-open-editor=""
            href={documentHref(metadata.id, shared, "edit")}
            size="small"
            variant="primary"
          >
            Edit
          </ButtonLink>
        ) : null}
      </div>
    </nav>
  );
}
