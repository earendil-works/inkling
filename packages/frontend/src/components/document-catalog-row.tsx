import { hasPendingPublicationChanges } from "@earendil-works/inkling-core";
import type { CatalogResponse } from "@earendil-works/inkling-protocol";

import { documentFolio, documentHref, formatDate, publicDocumentHref } from "../ui.ts";
import styles from "./document-catalog.module.css";
import { AudienceChip, Chip, LifecycleStateChip } from "./chip.tsx";

export interface DocumentCatalogRowProps {
  readonly document: CatalogResponse["documents"][number];
  readonly onFocus?: (() => void) | undefined;
  readonly publicDocument?: boolean | undefined;
  readonly selected?: boolean | undefined;
}

export function DocumentCatalogRow({
  document,
  onFocus,
  publicDocument = false,
  selected = false,
}: DocumentCatalogRowProps): React.JSX.Element {
  const { excerpt, metadata } = document;

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
      onFocus={onFocus}
    >
      <span className={styles["folio"]} data-catalog-folio="">
        {documentFolio(metadata.rfcNumber)}
      </span>
      <span className={styles["main"]}>
        <span className={styles["title"]}>
          <strong>{metadata.title}</strong>
          {!publicDocument &&
          // Personal documents are never published, so they have nothing pending.
          metadata.personalOwner === undefined &&
          hasPendingPublicationChanges(metadata) ? (
            <Chip data-pending-edits="">Pending edits</Chip>
          ) : null}
        </span>
        <small>{excerpt || "No body text yet"}</small>
      </span>
      <span className={styles["meta"]} data-catalog-metadata="">
        <span className={styles["chipCell"]} data-catalog-visibility="">
          <AudienceChip metadata={metadata} />
        </span>
        <span className={styles["chipCell"]}>
          <LifecycleStateChip state={metadata.lifecycleState} />
        </span>
        <time dateTime={metadata.updatedAt}>{formatDate(metadata.updatedAt)}</time>
      </span>
    </a>
  );
}
