import { hasPendingPublicationChanges } from "@earendil-works/inkling-core";
import type { CatalogResponse } from "@earendil-works/inkling-protocol";

import { documentHref, formatDate, publicDocumentHref } from "../ui.ts";
import { LifecycleStateChip } from "./lifecycle-state-chip.tsx";

export interface DocumentCatalogRowProps {
  readonly document: CatalogResponse["documents"][number];
  readonly publicDocument?: boolean | undefined;
}

export function DocumentCatalogRow({
  document,
  publicDocument = false,
}: DocumentCatalogRowProps): React.JSX.Element {
  const { excerpt, metadata } = document;
  const number =
    metadata.rfcNumber === undefined
      ? "NOTE"
      : `RFC ${String(metadata.rfcNumber).padStart(4, "0")}`;

  return (
    <a
      className="catalog-row"
      data-document-visibility={metadata.visibility}
      data-native-navigation={publicDocument ? "" : undefined}
      href={
        publicDocument
          ? publicDocumentHref(metadata.id, metadata.rfcNumber)
          : documentHref(metadata.id, metadata.rfcNumber, false, "read", "")
      }
    >
      <span className="catalog-row__folio">{number}</span>
      <span className="catalog-row__main">
        <span className="catalog-row__title">
          <strong>{metadata.title}</strong>
          {!publicDocument && hasPendingPublicationChanges(metadata) ? (
            <span className="catalog-row__pending" data-pending-edits="">
              Pending edits
            </span>
          ) : null}
        </span>
        <small>{excerpt || "No body text yet"}</small>
      </span>
      <span className="catalog-row__meta">
        <span className="catalog-row__visibility" data-document-visibility={metadata.visibility}>
          {metadata.visibility}
        </span>
        <LifecycleStateChip className="catalog-row__state" state={metadata.lifecycleState} />
        <time dateTime={metadata.updatedAt}>{formatDate(metadata.updatedAt)}</time>
      </span>
    </a>
  );
}
