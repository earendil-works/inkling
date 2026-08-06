import { useEffect, useState } from "react";
import { Effect } from "effect";

import type { ApiKeyCreated, ApiKeyDto } from "@earendil-works/jot-protocol";

import type { ApiClientService, ApiError } from "../api.ts";
import { useEffectAction, useEffectQuery } from "../effect-hooks.ts";
import { Button } from "./button.tsx";
import { FormError } from "./form-error.tsx";
import { ModalDialog } from "./modal-dialog.tsx";
import { TextField } from "./text-field.tsx";

export interface SettingsDialogProps {
  readonly api: ApiClientService;
  readonly onClose: () => void;
}

export function SettingsDialog({ api, onClose }: SettingsDialogProps): React.JSX.Element {
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
    <ModalDialog className="settings-dialog" data-settings-dialog="" onDismiss={onClose} open>
      <form data-settings-form="" onSubmit={submit}>
        <div className="dialog-heading">
          <p className="eyebrow">API keys / agent access</p>
          <Button aria-label="Close" onClick={onClose} variant="icon">
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
                  variant="text"
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
        <Button disabled={createKey.state.pending} type="submit" variant="primary">
          {createKey.state.pending ? "Creating…" : "Create API key"}
        </Button>
        {agentCommand === undefined ? null : (
          <section className="agent-instructions" data-agent-instructions="">
            <b>Copy this now — the key is shown once.</b>
            <pre data-agent-command="">{agentCommand}</pre>
            <Button
              data-copy-agent=""
              onClick={() => copyCommand.execute(agentCommand)}
              variant="text"
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
