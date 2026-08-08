import type { CatalogResponse } from "@earendil-works/inkling-protocol";

import { DocumentCatalogRow } from "./document-catalog-row.tsx";

export interface DocumentCatalogProps {
  readonly catalog: CatalogResponse;
  readonly publicCatalog?: boolean | undefined;
}

export function DocumentCatalog({
  catalog,
  publicCatalog = false,
}: DocumentCatalogProps): React.JSX.Element {
  if (catalog.documents.length === 0) {
    return (
      <section className="catalog" data-catalog="" aria-live="polite">
        <div className="empty-state">
          <span>Ø</span>
          <h2>No notes or RFCs found.</h2>
          <p>
            {publicCatalog
              ? "No public revisions have been published yet."
              : "Create one or adjust the search."}
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="catalog" data-catalog="" aria-live="polite">
      {catalog.documents.map((document) => (
        <DocumentCatalogRow
          document={document}
          key={document.metadata.id}
          publicDocument={publicCatalog}
        />
      ))}
    </section>
  );
}
