import { useState } from "react";

import type { CatalogResponse } from "@earendil-works/inkling-protocol";

import type { ApiClientService } from "./api.ts";
import { CatalogControls } from "./components/catalog-controls.tsx";
import { DocumentCatalog } from "./components/document-catalog.tsx";
import { NewDocumentControl } from "./components/new-document-control.tsx";

export interface WorkspaceScreenProps {
  readonly api: ApiClientService;
  readonly initialCatalog: CatalogResponse;
  readonly publicCatalog?: boolean | undefined;
}

export function WorkspaceScreen({
  api,
  initialCatalog,
  publicCatalog = false,
}: WorkspaceScreenProps): React.JSX.Element {
  const [catalog, setCatalog] = useState(initialCatalog);

  return (
    <main
      className="workspace-layout"
      data-public-catalog={publicCatalog ? "" : undefined}
      id="app"
      tabIndex={-1}
    >
      <section className="workspace-heading">
        <div>
          <p className="eyebrow">
            {publicCatalog ? "Public archive / published revisions" : "Workspace / notes & RFCs"}
          </p>
          <h1>Inkling</h1>
        </div>
        {publicCatalog ? null : <NewDocumentControl api={api} />}
      </section>
      <CatalogControls
        api={api}
        initialCatalog={initialCatalog}
        onResultsChange={setCatalog}
        publicCatalog={publicCatalog}
      />
      <DocumentCatalog catalog={catalog} publicCatalog={publicCatalog} />
    </main>
  );
}
