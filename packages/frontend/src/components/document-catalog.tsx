import type { CatalogResponse } from "@earendil-works/jot-protocol";

import { DocumentCatalogRow } from "./document-catalog-row.tsx";

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
      {catalog.documents.map((document, index) => (
        <DocumentCatalogRow document={document} index={index} key={document.metadata.id} />
      ))}
    </section>
  );
}
