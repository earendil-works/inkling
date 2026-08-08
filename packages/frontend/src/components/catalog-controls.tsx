import type { CatalogResponse } from "@earendil-works/jot-protocol";

import type { ApiClientService } from "../api.ts";
import { ButtonLink } from "./button-link.tsx";
import { DocumentSearch } from "./document-search.tsx";

export interface CatalogControlsProps {
  readonly api: ApiClientService;
  readonly initialCatalog: CatalogResponse;
  readonly onResultsChange: (catalog: CatalogResponse) => void;
}

export function CatalogControls({
  api,
  initialCatalog,
  onResultsChange,
}: CatalogControlsProps): React.JSX.Element {
  return (
    <section className="catalog-tools" aria-label="Document tools">
      <DocumentSearch api={api} initialCatalog={initialCatalog} onResultsChange={onResultsChange} />
      <div className="catalog-tool-links">
        <ButtonLink href="/labels" variant="text">
          Browse labels
        </ButtonLink>
      </div>
    </section>
  );
}
