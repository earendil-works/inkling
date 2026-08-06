import { useDeferredValue, useEffect, useState } from "react";
import { Effect } from "effect";

import type {
  ApiKeyCreated,
  ApiKeyDto,
  CatalogResponse,
  CreateDocumentRequest,
  DocumentResponse,
} from "@earendil-works/jot-protocol";

import type { ApiClientService, ApiError } from "./api.ts";
import { useAppContext } from "./app-context.tsx";
import { Button } from "./components/button.tsx";
import { CheckboxField } from "./components/checkbox-field.tsx";
import { DocumentCatalog } from "./components/document-catalog.tsx";
import { FormError } from "./components/form-error.tsx";
import { LogoutButton } from "./components/logout-button.tsx";
import { ModalDialog } from "./components/modal-dialog.tsx";
import { TextareaField } from "./components/textarea-field.tsx";
import { TextField } from "./components/text-field.tsx";
import { useEffectAction, useEffectQuery } from "./effect-hooks.ts";
import { randomId } from "./ui.ts";

export interface WorkspaceScreenProps {
  readonly api: ApiClientService;
  readonly initialCatalog: CatalogResponse;
}

export function WorkspaceScreen({ api, initialCatalog }: WorkspaceScreenProps): React.JSX.Element {
  const { navigate, setStatus } = useAppContext();
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const catalogQuery = useEffectQuery(
    api.listDocuments(deferredSearch),
    `catalog:${deferredSearch}`,
  );
  const [newDocumentOpen, setNewDocumentOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [allocateRfc, setAllocateRfc] = useState(false);
  const createDocument = useEffectAction<CreateDocumentRequest, DocumentResponse, ApiError>(
    (input) => api.createDocument(input),
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const catalog = catalogQuery.state.data ?? initialCatalog;

  useEffect(() => {
    setStatus({ label: "Workspace connected", state: "ready" });
  }, [setStatus]);

  const submitDocument = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    createDocument.execute(
      {
        allocateRfc,
        body,
        creationKey: randomId("request"),
        title,
      },
      {
        onSuccess: (document) => {
          setNewDocumentOpen(false);
          navigate(`/documents/${encodeURIComponent(document.metadata.id)}`);
        },
      },
    );
  };

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
      <ModalDialog
        className="new-document"
        data-new-dialog=""
        onDismiss={() => setNewDocumentOpen(false)}
        open={newDocumentOpen}
      >
        <form data-new-form="" onSubmit={submitDocument}>
          <div className="dialog-heading">
            <p className="eyebrow">Begin a working head</p>
            <Button
              aria-label="Close"
              variant="icon"
              onClick={() => setNewDocumentOpen(false)}
              type="button"
            >
              ×
            </Button>
          </div>
          <TextField
            autoFocus
            label="Title"
            maxLength={300}
            name="title"
            onChange={(event) => setTitle(event.currentTarget.value)}
            required
            value={title}
          />
          <CheckboxField
            checked={allocateRfc}
            label="Allocate an RFC number"
            name="rfc"
            onChange={(event) => setAllocateRfc(event.currentTarget.checked)}
          />
          <TextareaField
            label="Opening Markdown"
            name="body"
            onChange={(event) => setBody(event.currentTarget.value)}
            placeholder={"# Context\n\nStart with the decision…"}
            rows={9}
            value={body}
          />
          <Button variant="primary" disabled={createDocument.state.pending} type="submit">
            {createDocument.state.pending ? "Creating…" : "Create document"}
          </Button>
          <FormError data-new-error="">{createDocument.state.error?.message}</FormError>
        </form>
      </ModalDialog>
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
