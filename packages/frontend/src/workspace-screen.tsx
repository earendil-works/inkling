import { useState } from "react";

import type { CatalogResponse } from "@earendil-works/jot-protocol";

import type { ApiClientService } from "./api.ts";
import { CatalogControls } from "./components/catalog-controls.tsx";
import { DocumentCatalog } from "./components/document-catalog.tsx";
import { NewDocumentControl } from "./components/new-document-control.tsx";

export interface WorkspaceScreenProps {
  readonly api: ApiClientService;
  readonly initialCatalog: CatalogResponse;
}

export function WorkspaceScreen({ api, initialCatalog }: WorkspaceScreenProps): React.JSX.Element {
  const [catalog, setCatalog] = useState(initialCatalog);

  return (
    <main className="workspace-layout" id="app" tabIndex={-1}>
      <section className="workspace-heading">
        <div>
          <p className="eyebrow">Workspace / recent activity</p>
          <h1>Jots</h1>
        </div>
        <NewDocumentControl api={api} />
      </section>
      <CatalogControls api={api} initialCatalog={initialCatalog} onResultsChange={setCatalog} />
      <DocumentCatalog catalog={catalog} />
    </main>
  );
}
