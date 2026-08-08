import type { DocumentMetadataDto } from "@earendil-works/inkling-protocol";

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
}: ReaderToolbarProps): React.JSX.Element | null {
  const canEdit = !publicDocument && (!shared || metadata.sharing.access === "edit");
  if (!canEdit) return null;

  return (
    <nav className="document-bar reader-toolbar" aria-label="Document navigation">
      <ButtonLink
        className="document-mode-link"
        data-open-editor=""
        href={documentHref(metadata.id, metadata.rfcNumber, shared, "edit")}
        size="small"
        variant="primary"
      >
        Edit
      </ButtonLink>
    </nav>
  );
}
