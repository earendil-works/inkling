import type { DocumentMetadataDto } from "@earendil-works/jot-protocol";

import { documentHref } from "../ui.ts";
import { ButtonLink } from "./button-link.tsx";

export interface ReaderToolbarProps {
  readonly metadata: DocumentMetadataDto;
  readonly publicDocument?: boolean | undefined;
  readonly shared: boolean;
}

export function ReaderToolbar({
  metadata,
  publicDocument = false,
  shared,
}: ReaderToolbarProps): React.JSX.Element {
  const canEdit = !publicDocument && (!shared || metadata.sharing.access === "edit");

  return (
    <nav className="document-bar reader-toolbar" aria-label="Document navigation">
      <ButtonLink className="reader-back-link" href="/" variant="text">
        All notes and RFCs
      </ButtonLink>
      {canEdit ? (
        <ButtonLink
          className="document-mode-link"
          data-open-editor=""
          href={documentHref(metadata.id, metadata.rfcNumber, shared, "edit")}
          size="small"
          variant="primary"
        >
          Edit
        </ButtonLink>
      ) : null}
    </nav>
  );
}
