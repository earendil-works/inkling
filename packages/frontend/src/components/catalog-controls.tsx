import { useState } from "react";

import type { ApiClientService } from "../api.ts";
import { Button } from "./button.tsx";
import { LogoutButton } from "./logout-button.tsx";
import { SettingsDialog } from "./settings-dialog.tsx";
import { TextField } from "./text-field.tsx";

export interface CatalogControlsProps {
  readonly api: ApiClientService;
  readonly onSearchChange: (search: string) => void;
  readonly search: string;
}

export function CatalogControls({
  api,
  onSearchChange,
  search,
}: CatalogControlsProps): React.JSX.Element {
  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    <>
      <section className="catalog-tools" aria-label="Document tools">
        <TextField
          className="search-field"
          data-search=""
          label="Search"
          onChange={(event) => onSearchChange(event.currentTarget.value)}
          placeholder="Title, body, people, state…"
          type="search"
          value={search}
        />
        <Button variant="text" data-settings="" onClick={() => setSettingsOpen(true)}>
          API &amp; agents
        </Button>
        <LogoutButton api={api} />
      </section>
      {settingsOpen ? <SettingsDialog api={api} onClose={() => setSettingsOpen(false)} /> : null}
    </>
  );
}
