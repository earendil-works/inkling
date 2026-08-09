import { hasPendingPublicationChanges } from "@earendil-works/inkling-core";
import type { CatalogResponse } from "@earendil-works/inkling-protocol";

import { documentHref, formatDate, publicDocumentHref } from "../ui.ts";
import styles from "./document-catalog.module.css";
import { LifecycleStateChip } from "./lifecycle-state-chip.tsx";

export interface DocumentCatalogRowProps {
  readonly document: CatalogResponse["documents"][number];
  readonly onSelect?: (() => void) | undefined;
  readonly publicDocument?: boolean | undefined;
  readonly selected?: boolean | undefined;
}

export function DocumentCatalogRow({
  document,
  onSelect,
  publicDocument = false,
  selected = false,
}: DocumentCatalogRowProps): React.JSX.Element {
  const { excerpt, metadata } = document;
  const number =
    metadata.rfcNumber === undefined
      ? "NOTE"
      : `RFC ${String(metadata.rfcNumber).padStart(4, "0")}`;

  return (
    <a
      className={styles["row"]}
      data-catalog-document-id={metadata.id}
      data-catalog-selected={selected ? "" : undefined}
      data-document-visibility={metadata.visibility}
      data-native-navigation={publicDocument ? "" : undefined}
      href={
        publicDocument
          ? publicDocumentHref(metadata.id, metadata.rfcNumber)
          : documentHref(metadata.id, metadata.rfcNumber, false, "read", "")
      }
      onFocus={onSelect}
      onPointerMove={onSelect}
    >
      <span className={styles["folio"]} data-catalog-folio="">
        {number}
      </span>
      <span className={styles["main"]}>
        <span className={styles["title"]}>
          <strong>{metadata.title}</strong>
          {!publicDocument && hasPendingPublicationChanges(metadata) ? (
            <span className={styles["pending"]} data-pending-edits="">
              Pending edits
            </span>
          ) : null}
        </span>
        <small>{excerpt || "No body text yet"}</small>
      </span>
      <span className={styles["meta"]} data-catalog-metadata="">
        <span
          className={styles["visibility"]}
          data-catalog-visibility=""
          data-document-visibility={metadata.visibility}
        >
          {metadata.visibility}
        </span>
        <LifecycleStateChip className={styles["state"]} state={metadata.lifecycleState} />
        <time dateTime={metadata.updatedAt}>{formatDate(metadata.updatedAt)}</time>
      </span>
    </a>
  );
}
