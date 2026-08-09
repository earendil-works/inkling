import type { CatalogResponse } from "@earendil-works/inkling-protocol";

import type { ApiClientService } from "../api.ts";
import { ButtonLink } from "./button-link.tsx";
import { DocumentSearch } from "./document-search.tsx";

export interface CatalogControlsProps {
  readonly api: ApiClientService;
  readonly currentUserEmail?: string | undefined;
  readonly initialCatalog: CatalogResponse;
  readonly onResultsChange: (catalog: CatalogResponse) => void;
  readonly publicCatalog?: boolean | undefined;
}

export function CatalogControls({
  api,
  currentUserEmail,
  initialCatalog,
  onResultsChange,
  publicCatalog = false,
}: CatalogControlsProps): React.JSX.Element {
  return (
    <section className="catalog-tools" aria-label="Document tools">
      <DocumentSearch
        api={api}
        currentUserEmail={currentUserEmail}
        initialCatalog={initialCatalog}
        onResultsChange={onResultsChange}
        publicCatalog={publicCatalog}
      />
      <div className="catalog-tool-links">
        <ButtonLink href="/labels" variant="text">
          Browse labels
        </ButtonLink>
      </div>
    </section>
  );
}
