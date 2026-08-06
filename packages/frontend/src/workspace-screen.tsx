import { useDeferredValue, useEffect, useState } from "react";
import { Effect } from "effect";

import type { ApiKeyCreated, ApiKeyDto, CatalogResponse } from "@earendil-works/jot-protocol";

import type { ApiClientService, ApiError } from "./api.ts";
import { useAppContext } from "./app-context.tsx";
import { Button } from "./components/button.tsx";
import { DocumentCatalog } from "./components/document-catalog.tsx";
import { FormError } from "./components/form-error.tsx";
import { LogoutButton } from "./components/logout-button.tsx";
import { ModalDialog } from "./components/modal-dialog.tsx";
import { NewDocumentDialog } from "./components/new-document-dialog.tsx";
import { TextField } from "./components/text-field.tsx";
import { useEffectAction, useEffectQuery } from "./effect-hooks.ts";

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

interface SettingsDialogProps {
  readonly api: ApiClientService;
  readonly onClose: () => void;
}

function SettingsDialog({ api, onClose }: SettingsDialogProps): React.JSX.Element {
  const [label, setLabel] = useState("");
  const [keys, setKeys] = useState<readonly ApiKeyDto[]>([]);
  const [agentCommand, setAgentCommand] = useState<string>();
  const keyQuery = useEffectQuery(api.listApiKeys, "api-keys");
  const createKey = useEffectAction<string, ApiKeyCreated, ApiError>((value) =>
    api.createApiKey(value),
  );
  const revokeKey = useEffectAction<string, void, ApiError>((keyId) => api.revokeApiKey(keyId));
  const copyCommand = useEffectAction<string, void, never>((command) =>
    Effect.tryPromise({
      catch: () => undefined,
      try: () => navigator.clipboard.writeText(command),
    }).pipe(Effect.ignore),
  );

  useEffect(() => {
    if (keyQuery.state.data !== undefined) setKeys(keyQuery.state.data);
  }, [keyQuery.state.data]);

  const close = (): void => onClose();
  const submit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (label.trim() === "") return;
    createKey.execute(label, {
      onSuccess: (created) => {
        setKeys((current) => [created.metadata, ...current]);
        setAgentCommand(`jot instance add workspace ${location.origin} ${created.key}`);
        setLabel("");
      },
    });
  };

  return (
    <ModalDialog className="settings-dialog" data-settings-dialog="" onDismiss={close} open>
      <form data-settings-form="" onSubmit={submit}>
        <div className="dialog-heading">
          <p className="eyebrow">API keys / agent access</p>
          <Button aria-label="Close" variant="icon" onClick={close} type="button">
            ×
          </Button>
        </div>
        <div data-api-keys="">
          {keyQuery.state.status === "loading" && keys.length === 0 ? <p>Loading keys…</p> : null}
          {keys.length === 0 && keyQuery.state.status !== "loading" ? (
            <p>No API keys created.</p>
          ) : null}
          {keys.map((key) => (
            <div className="api-key-row" key={key.id}>
              <span>
                <b>{key.label}</b>
                <small>{key.revokedAt === undefined ? "Active" : "Revoked"}</small>
              </span>
              {key.revokedAt === undefined ? (
                <Button
                  variant="text"
                  data-revoke-key={key.id}
                  onClick={() => {
                    if (!window.confirm("Revoke this API key?")) return;
                    revokeKey.execute(key.id, {
                      onSuccess: () =>
                        setKeys((current) =>
                          current.map((item) =>
                            item.id === key.id
                              ? { ...item, revokedAt: new Date().toISOString() }
                              : item,
                          ),
                        ),
                    });
                  }}
                  type="button"
                >
                  Revoke
                </Button>
              ) : null}
            </div>
          ))}
        </div>
        <TextField
          label="New key label"
          maxLength={200}
          name="api-key-label"
          onChange={(event) => setLabel(event.currentTarget.value)}
          placeholder="Laptop agent"
          value={label}
        />
        <Button variant="primary" disabled={createKey.state.pending} type="submit">
          Create API key
        </Button>
        {agentCommand === undefined ? null : (
          <section className="agent-instructions" data-agent-instructions="">
            <b>Copy this now — the key is shown once.</b>
            <pre data-agent-command="">{agentCommand}</pre>
            <Button
              variant="text"
              data-copy-agent=""
              onClick={() => copyCommand.execute(agentCommand)}
              type="button"
            >
              Copy setup command
            </Button>
          </section>
        )}
        <FormError data-settings-error="">
          {keyQuery.state.status === "failure" ? keyQuery.state.error.message : null}
          {createKey.state.error?.message}
          {revokeKey.state.error?.message}
        </FormError>
      </form>
    </ModalDialog>
  );
}
