import { useDeferredValue, useEffect, useState } from "react";

import type { CatalogResponse } from "@earendil-works/jot-protocol";

import type { ApiClientService } from "./api.ts";
import { useAppContext } from "./app-context.tsx";
import { CatalogControls } from "./components/catalog-controls.tsx";
import { DocumentCatalog } from "./components/document-catalog.tsx";
import { NewDocumentControl } from "./components/new-document-control.tsx";
import { useEffectQuery } from "./effect-hooks.ts";

export interface WorkspaceScreenProps {
  readonly api: ApiClientService;
  readonly initialCatalog: CatalogResponse;
}

export function WorkspaceScreen({ api, initialCatalog }: WorkspaceScreenProps): React.JSX.Element {
  const { setStatus } = useAppContext();
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const catalogQuery = useEffectQuery(
    api.listDocuments(deferredSearch),
    `catalog:${deferredSearch}`,
  );
  const catalog = catalogQuery.state.data ?? initialCatalog;

  useEffect(() => {
    setStatus({ label: "Workspace connected", state: "ready" });
  }, [setStatus]);

  return (
    <main className="workspace-layout" id="app" tabIndex={-1}>
      <section className="workspace-heading">
        <div>
          <p className="eyebrow">Workspace / recent activity</p>
          <h1>The working set.</h1>
        </div>
        <NewDocumentControl api={api} />
      </section>
      <CatalogControls api={api} onSearchChange={setSearch} search={search} />
      <DocumentCatalog catalog={catalog} />
    </main>
  );
}
