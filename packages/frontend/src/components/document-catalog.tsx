import type { CatalogResponse } from "@earendil-works/jot-protocol";

import { formatDate } from "../ui.ts";

export interface DocumentCatalogProps {
  readonly catalog: CatalogResponse;
}

export function DocumentCatalog({ catalog }: DocumentCatalogProps): React.JSX.Element {
  if (catalog.documents.length === 0) {
    return (
      <section className="catalog" data-catalog="" aria-live="polite">
        <div className="empty-state">
          <span>Ø</span>
          <h2>No documents found.</h2>
          <p>Start a document or adjust the search.</p>
        </div>
      </section>
    );
  }

  return (
    <section className="catalog" data-catalog="" aria-live="polite">
      {catalog.documents.map(({ excerpt, metadata }, index) => {
        const number =
          metadata.rfcNumber === undefined
            ? "NOTE"
            : `RFC ${String(metadata.rfcNumber).padStart(4, "0")}`;
        return (
          <a
            className="catalog-row"
            href={`/documents/${encodeURIComponent(metadata.id)}`}
            key={metadata.id}
          >
            <span className="catalog-row__index">{String(index + 1).padStart(2, "0")}</span>
            <span className="catalog-row__main">
              <strong>{metadata.title}</strong>
              <small>{excerpt || "No body text yet"}</small>
            </span>
            <span className="catalog-row__meta">
              <b>{number}</b>
              <span>{metadata.lifecycleState}</span>
              <time dateTime={metadata.updatedAt}>{formatDate(metadata.updatedAt)}</time>
            </span>
          </a>
        );
      })}
    </section>
  );
}
