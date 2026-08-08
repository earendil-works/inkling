import { hasPendingPublicationChanges } from "@earendil-works/jot-core";
import type { CatalogResponse } from "@earendil-works/jot-protocol";

import { documentHref, formatDate, publicDocumentHref } from "../ui.ts";
import { LifecycleStateChip } from "./lifecycle-state-chip.tsx";

export interface DocumentCatalogRowProps {
  readonly document: CatalogResponse["documents"][number];
  readonly index: number;
  readonly publicDocument?: boolean | undefined;
}

export function DocumentCatalogRow({
  document,
  index,
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
      data-native-navigation={publicDocument ? "" : undefined}
      href={
        publicDocument
          ? publicDocumentHref(metadata.id, metadata.rfcNumber)
          : documentHref(metadata.id, metadata.rfcNumber, false, "read", "")
      }
    >
      <span className="catalog-row__index">{String(index + 1).padStart(2, "0")}</span>
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
        <b>{number}</b>
        <LifecycleStateChip className="catalog-row__state" state={metadata.lifecycleState} />
        <time dateTime={metadata.updatedAt}>{formatDate(metadata.updatedAt)}</time>
      </span>
    </a>
  );
}
