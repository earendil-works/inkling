import { useState } from "react";

import type { CatalogResponse } from "@earendil-works/jot-protocol";

import type { ApiClientService } from "../api.ts";
import { ButtonLink } from "./button-link.tsx";
import { Button } from "./button.tsx";
import { DocumentSearch } from "./document-search.tsx";
import { SettingsDialog } from "./settings-dialog.tsx";

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
  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    <>
      <section className="catalog-tools" aria-label="Document tools">
        <DocumentSearch
          api={api}
          initialCatalog={initialCatalog}
          onResultsChange={onResultsChange}
        />
        <div className="catalog-tool-links">
          <ButtonLink href="/labels" variant="text">
            Browse labels
          </ButtonLink>
          <Button variant="text" data-settings="" onClick={() => setSettingsOpen(true)}>
            API &amp; agents
          </Button>
        </div>
      </section>
      {settingsOpen ? <SettingsDialog api={api} onClose={() => setSettingsOpen(false)} /> : null}
    </>
  );
}
