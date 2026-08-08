import { useEffect, useState } from "react";
import { Effect } from "effect";

import type { ApiKeyCreated, ApiKeyDto } from "@earendil-works/inkling-protocol";

import type { ApiClientService, ApiError } from "../api.ts";
import { useEffectAction, useEffectQuery } from "../effect-hooks.ts";
import { Button } from "./button.tsx";
import { ConfirmationDialog } from "./confirmation-dialog.tsx";
import { DialogHeader } from "./dialog-header.tsx";
import { FormError } from "./form-error.tsx";
import { ModalDialog } from "./modal-dialog.tsx";
import { TextField } from "./text-field.tsx";

export interface SettingsDialogProps {
  readonly accountName: string;
  readonly api: ApiClientService;
  readonly onClose: () => void;
}

export function SettingsDialog({
  accountName,
  api,
  onClose,
}: SettingsDialogProps): React.JSX.Element {
  const [label, setLabel] = useState("My agent");
  const [keys, setKeys] = useState<readonly ApiKeyDto[]>([]);
  const [agentCommand, setAgentCommand] = useState<string>();
  const [commandCopied, setCommandCopied] = useState(false);
  const [keyToRevoke, setKeyToRevoke] = useState<ApiKeyDto>();
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

  const activeKeys = keys.filter((key) => key.revokedAt === undefined);
  const submit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const normalizedLabel = label.trim();
    if (normalizedLabel === "") return;
    createKey.execute(normalizedLabel, {
      onSuccess: (created) => {
        setKeys((current) => [created.metadata, ...current]);
        setAgentCommand(
          `inkling instance add workspace ${location.origin} ${created.key} && inkling use workspace`,
        );
        setCommandCopied(false);
        setLabel("My agent");
      },
    });
  };

  const errors = [
    keyQuery.state.status === "failure" ? keyQuery.state.error.message : undefined,
    createKey.state.error?.message,
    revokeKey.state.error?.message,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <>
      <ModalDialog
        aria-labelledby="settings-dialog-title"
        className="settings-dialog"
        data-settings-dialog=""
        onDismiss={onClose}
        open
      >
        <form data-settings-form="" onSubmit={submit}>
          <DialogHeader
            closeLabel="Close API keys"
            eyebrow={`${accountName} / personal access`}
            onClose={onClose}
            title="API keys"
            titleId="settings-dialog-title"
          />
          <p className="dialog-note">
            Keys belong to your account and have the same workspace permissions you do. Use one to
            connect the Inkling CLI or a coding agent.
          </p>

          {agentCommand === undefined ? null : (
            <section className="agent-instructions" data-agent-instructions="">
              <p className="eyebrow">Ready to connect</p>
              <h3>Run this once</h3>
              <p>Paste this command into the terminal where your agent works.</p>
              <pre data-agent-command="">
                <code>{agentCommand}</code>
              </pre>
              <div className="agent-instructions__action">
                <Button
                  data-copy-agent=""
                  onClick={() =>
                    copyCommand.execute(agentCommand, {
                      onSuccess: () => setCommandCopied(true),
                    })
                  }
                  variant="text"
                >
                  {commandCopied ? "Copied" : "Copy setup command"}
                </Button>
                <span aria-live="polite">{commandCopied ? "Command copied." : ""}</span>
              </div>
              <small>
                The secret is shown only now. The CLI stores it in your user-only config; never put
                it in AGENTS.md or an agent skill. Run <code>inkling --help</code> next.
              </small>
            </section>
          )}

          <section className="api-key-create" aria-labelledby="api-key-create-title">
            <div>
              <h3 id="api-key-create-title">Create a personal key</h3>
              <p>Name the device or agent so it is easy to revoke later.</p>
            </div>
            <div className="api-key-create__controls">
              <TextField
                label="Key name"
                maxLength={200}
                name="api-key-label"
                onChange={(event) => setLabel(event.currentTarget.value)}
                placeholder="My agent"
                value={label}
              />
              <Button disabled={createKey.state.pending} type="submit" variant="primary">
                {createKey.state.pending ? "Creating…" : "Create API key"}
              </Button>
            </div>
          </section>

          <section className="api-key-list" aria-labelledby="api-key-list-title" data-api-keys="">
            <div className="api-key-list__heading">
              <h3 id="api-key-list-title">Active keys</h3>
              <span>{activeKeys.length}</span>
            </div>
            {keyQuery.state.status === "loading" && keys.length === 0 ? <p>Loading keys…</p> : null}
            {activeKeys.length === 0 && keyQuery.state.status !== "loading" ? (
              <p className="api-key-list__empty">No active API keys.</p>
            ) : null}
            {activeKeys.map((key) => (
              <div className="api-key-row" key={key.id}>
                <span>
                  <b>{key.label}</b>
                  <small>{keyActivity(key)}</small>
                </span>
                <Button data-revoke-key={key.id} onClick={() => setKeyToRevoke(key)} variant="text">
                  Revoke
                </Button>
              </div>
            ))}
          </section>
          <FormError data-settings-error="">{errors}</FormError>
        </form>
      </ModalDialog>
      <ConfirmationDialog
        confirmLabel="Revoke key"
        description={
          keyToRevoke === undefined
            ? "This API key will stop working immediately."
            : `“${keyToRevoke.label}” will stop working immediately.`
        }
        onCancel={() => setKeyToRevoke(undefined)}
        onConfirm={() => {
          if (keyToRevoke === undefined) return;
          revokeKey.execute(keyToRevoke.id, {
            onFailure: () => setKeyToRevoke(undefined),
            onSuccess: () => {
              setKeys((current) => current.filter((item) => item.id !== keyToRevoke.id));
              setKeyToRevoke(undefined);
            },
          });
        }}
        open={keyToRevoke !== undefined}
        pending={revokeKey.state.pending}
        title="Revoke this API key?"
        tone="danger"
      />
    </>
  );
}

function keyActivity(key: ApiKeyDto): string {
  return key.lastUsedAt === undefined
    ? `Created ${formatDate(key.createdAt)} · Never used`
    : `Last used ${formatDate(key.lastUsedAt)}`;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(value));
}
