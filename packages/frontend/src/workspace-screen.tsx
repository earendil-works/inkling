import { useDeferredValue, useEffect, useRef, useState } from "react";
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
import { useEffectAction, useEffectQuery } from "./effect-hooks.ts";
import { formatDate, randomId } from "./ui.ts";

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
  const newDialogRef = useRef<HTMLDialogElement>(null);
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
          newDialogRef.current?.close();
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
        <button
          className="primary-button"
          data-new-document=""
          onClick={() => newDialogRef.current?.showModal()}
          type="button"
        >
          New document
        </button>
      </section>
      <section className="catalog-tools" aria-label="Document tools">
        <label className="search-field">
          <span>Search</span>
          <input
            data-search=""
            onChange={(event) => setSearch(event.currentTarget.value)}
            placeholder="Title, body, people, state…"
            type="search"
            value={search}
          />
        </label>
        <button
          className="text-button"
          data-settings=""
          onClick={() => setSettingsOpen(true)}
          type="button"
        >
          API &amp; agents
        </button>
        <LogoutButton api={api} />
      </section>
      <Catalog catalog={catalog} />
      <dialog className="new-document" data-new-dialog="" ref={newDialogRef}>
        <form data-new-form="" onSubmit={submitDocument}>
          <div className="dialog-heading">
            <p className="eyebrow">Begin a working head</p>
            <button
              aria-label="Close"
              className="icon-button"
              onClick={() => newDialogRef.current?.close()}
              type="button"
            >
              ×
            </button>
          </div>
          <label>
            Title
            <input
              autoFocus
              maxLength={300}
              name="title"
              onChange={(event) => setTitle(event.currentTarget.value)}
              required
              value={title}
            />
          </label>
          <label className="checkbox">
            <input
              checked={allocateRfc}
              name="rfc"
              onChange={(event) => setAllocateRfc(event.currentTarget.checked)}
              type="checkbox"
            />
            Allocate an RFC number
          </label>
          <label>
            Opening Markdown
            <textarea
              name="body"
              onChange={(event) => setBody(event.currentTarget.value)}
              placeholder={"# Context\n\nStart with the decision…"}
              rows={9}
              value={body}
            />
          </label>
          <button className="primary-button" disabled={createDocument.state.pending} type="submit">
            {createDocument.state.pending ? "Creating…" : "Create document"}
          </button>
          <p className="form-error" data-new-error="">
            {createDocument.state.error?.message}
          </p>
        </form>
      </dialog>
      {settingsOpen ? <SettingsDialog api={api} onClose={() => setSettingsOpen(false)} /> : null}
    </main>
  );
}

function Catalog({ catalog }: { readonly catalog: CatalogResponse }): React.JSX.Element {
  if (catalog.documents.length === 0) {
    return (
      <section className="catalog" data-catalog="" aria-live="polite">
        <div className="empty-state">
          <span>Ø</span>
          <h2>No documents found.</h2>
          <p>Start a document or adjust the search.</p>
        </div>
      </section>
    );
  }
  return (
    <section className="catalog" data-catalog="" aria-live="polite">
      {catalog.documents.map(({ excerpt, metadata }, index) => {
        const number =
          metadata.rfcNumber === undefined
            ? "NOTE"
            : `RFC ${String(metadata.rfcNumber).padStart(4, "0")}`;
        return (
          <a
            className="catalog-row"
            href={`/documents/${encodeURIComponent(metadata.id)}`}
            key={metadata.id}
          >
            <span className="catalog-row__index">{String(index + 1).padStart(2, "0")}</span>
            <span className="catalog-row__main">
              <strong>{metadata.title}</strong>
              <small>{excerpt || "No body text yet"}</small>
            </span>
            <span className="catalog-row__meta">
              <b>{number}</b>
              <span>{metadata.lifecycleState}</span>
              <time>{formatDate(metadata.updatedAt)}</time>
            </span>
          </a>
        );
      })}
    </section>
  );
}

function LogoutButton({ api }: { readonly api: ApiClientService }): React.JSX.Element {
  const { navigate } = useAppContext();
  const logout = useEffectAction<void, void, ApiError>(() => api.logout);
  return (
    <button
      className="text-button"
      data-logout=""
      disabled={logout.state.pending}
      onClick={() =>
        logout.execute(undefined, { onSuccess: () => navigate("/", { replace: true }) })
      }
      type="button"
    >
      Sign out
    </button>
  );
}

interface SettingsDialogProps {
  readonly api: ApiClientService;
  readonly onClose: () => void;
}

function SettingsDialog({ api, onClose }: SettingsDialogProps): React.JSX.Element {
  const dialogRef = useRef<HTMLDialogElement>(null);
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
    dialogRef.current?.showModal();
  }, []);
  useEffect(() => {
    if (keyQuery.state.data !== undefined) setKeys(keyQuery.state.data);
  }, [keyQuery.state.data]);

  const close = (): void => {
    dialogRef.current?.close();
    onClose();
  };
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
    <dialog className="settings-dialog" data-settings-dialog="" onCancel={close} ref={dialogRef}>
      <form data-settings-form="" onSubmit={submit}>
        <div className="dialog-heading">
          <p className="eyebrow">API keys / agent access</p>
          <button aria-label="Close" className="icon-button" onClick={close} type="button">
            ×
          </button>
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
                <button
                  className="text-button"
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
                </button>
              ) : null}
            </div>
          ))}
        </div>
        <label>
          New key label
          <input
            maxLength={200}
            name="api-key-label"
            onChange={(event) => setLabel(event.currentTarget.value)}
            placeholder="Laptop agent"
            value={label}
          />
        </label>
        <button className="primary-button" disabled={createKey.state.pending} type="submit">
          Create API key
        </button>
        {agentCommand === undefined ? null : (
          <section className="agent-instructions" data-agent-instructions="">
            <b>Copy this now — the key is shown once.</b>
            <pre data-agent-command="">{agentCommand}</pre>
            <button
              className="text-button"
              data-copy-agent=""
              onClick={() => copyCommand.execute(agentCommand)}
              type="button"
            >
              Copy setup command
            </button>
          </section>
        )}
        <p className="form-error" data-settings-error="">
          {keyQuery.state.status === "failure" ? keyQuery.state.error.message : null}
          {createKey.state.error?.message}
          {revokeKey.state.error?.message}
        </p>
      </form>
    </dialog>
  );
}
