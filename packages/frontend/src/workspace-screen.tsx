import { useDeferredValue, useEffect, useState } from "react";

import type { CatalogResponse } from "@earendil-works/jot-protocol";

import type { ApiClientService } from "./api.ts";
import { useAppContext } from "./app-context.tsx";
import { Button } from "./components/button.tsx";
import { DocumentCatalog } from "./components/document-catalog.tsx";
import { LogoutButton } from "./components/logout-button.tsx";
import { NewDocumentDialog } from "./components/new-document-dialog.tsx";
import { SettingsDialog } from "./components/settings-dialog.tsx";
import { TextField } from "./components/text-field.tsx";
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
  const [newDocumentOpen, setNewDocumentOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
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
        <Button
          variant="primary"
          data-new-document=""
          onClick={() => setNewDocumentOpen(true)}
          type="button"
        >
          New document
        </Button>
      </section>
      <section className="catalog-tools" aria-label="Document tools">
        <TextField
          className="search-field"
          data-search=""
          label="Search"
          onChange={(event) => setSearch(event.currentTarget.value)}
          placeholder="Title, body, people, state…"
          type="search"
          value={search}
        />
        <Button variant="text" data-settings="" onClick={() => setSettingsOpen(true)} type="button">
          API &amp; agents
        </Button>
        <LogoutButton api={api} />
      </section>
      <DocumentCatalog catalog={catalog} />
      <NewDocumentDialog
        api={api}
        onDismiss={() => setNewDocumentOpen(false)}
        open={newDocumentOpen}
      />
      {settingsOpen ? <SettingsDialog api={api} onClose={() => setSettingsOpen(false)} /> : null}
    </main>
  );
}
