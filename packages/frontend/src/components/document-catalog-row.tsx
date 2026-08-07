import { hasPendingPublicationChanges } from "@earendil-works/jot-core";
import type { CatalogResponse } from "@earendil-works/jot-protocol";

import { formatDate } from "../ui.ts";

export interface DocumentCatalogRowProps {
  readonly document: CatalogResponse["documents"][number];
  readonly index: number;
}

export function DocumentCatalogRow({
  document,
  index,
}: DocumentCatalogRowProps): React.JSX.Element {
  const { excerpt, metadata } = document;
  const number =
    metadata.rfcNumber === undefined
      ? "NOTE"
      : `RFC ${String(metadata.rfcNumber).padStart(4, "0")}`;

  return (
    <a className="catalog-row" href={`/documents/${encodeURIComponent(metadata.id)}`}>
      <span className="catalog-row__index">{String(index + 1).padStart(2, "0")}</span>
      <span className="catalog-row__main">
        <span className="catalog-row__title">
          <strong>{metadata.title}</strong>
          {hasPendingPublicationChanges(metadata) ? (
            <span className="catalog-row__pending" data-pending-edits="">
              Pending edits
            </span>
          ) : null}
        </span>
        <small>{excerpt || "No body text yet"}</small>
      </span>
      <span className="catalog-row__meta">
        <b>{number}</b>
        <span>{metadata.lifecycleState}</span>
        <time dateTime={metadata.updatedAt}>{formatDate(metadata.updatedAt)}</time>
      </span>
    </a>
  );
}
