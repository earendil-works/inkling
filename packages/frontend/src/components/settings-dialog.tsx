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
import styles from "./settings-dialog.module.css";
import { TextField } from "./text-field.tsx";

export interface SettingsDialogProps {
  readonly api: ApiClientService;
  readonly onClose: () => void;
}

export function SettingsDialog({ api, onClose }: SettingsDialogProps): React.JSX.Element {
  const [label, setLabel] = useState("Agent access");
  const [keys, setKeys] = useState<readonly ApiKeyDto[]>([]);
  const [revealedKeys, setRevealedKeys] = useState<Readonly<Record<string, string>>>({});
  const [visibleKeyIds, setVisibleKeyIds] = useState<readonly string[]>([]);
  const [copiedKeyId, setCopiedKeyId] = useState<string>();
  const [revealingKeyId, setRevealingKeyId] = useState<string>();
  const [createOpen, setCreateOpen] = useState(false);
  const [keyToRevoke, setKeyToRevoke] = useState<ApiKeyDto>();
  const keyQuery = useEffectQuery(api.listApiKeys, "api-keys");
  const createKey = useEffectAction<string, ApiKeyCreated, ApiError>((value) =>
    api.createApiKey(value),
  );
  const revealKey = useEffectAction<string, ApiKeyCreated, ApiError>((keyId) =>
    api.revealApiKey(keyId),
  );
  const revokeKey = useEffectAction<string, void, ApiError>((keyId) => api.revokeApiKey(keyId));
  const copyKey = useEffectAction<string, void, never>((key) =>
    Effect.tryPromise({
      catch: () => undefined,
      try: () => navigator.clipboard.writeText(key),
    }).pipe(Effect.ignore),
  );

  useEffect(() => {
    const loaded = keyQuery.state.data;
    if (loaded === undefined) return;
    setKeys(loaded);
    if (!loaded.some((key) => key.revokedAt === undefined)) setCreateOpen(true);
  }, [keyQuery.state.data]);

  const activeKeys = keys.filter((key) => key.revokedAt === undefined);
  const submit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const normalizedLabel = label.trim();
    if (normalizedLabel === "") return;
    createKey.execute(normalizedLabel, {
      onSuccess: (created) => {
        setKeys((current) => [created.metadata, ...current]);
        setRevealedKeys((current) => ({ ...current, [created.metadata.id]: created.key }));
        setVisibleKeyIds((current) => [...new Set([...current, created.metadata.id])]);
        setCopiedKeyId(undefined);
        setCreateOpen(false);
        setLabel("Agent access");
      },
    });
  };

  const toggleKey = (key: ApiKeyDto): void => {
    if (visibleKeyIds.includes(key.id)) {
      setVisibleKeyIds((current) => current.filter((id) => id !== key.id));
      setCopiedKeyId(undefined);
      return;
    }
    if (revealedKeys[key.id] !== undefined) {
      setVisibleKeyIds((current) => [...new Set([...current, key.id])]);
      return;
    }
    setRevealingKeyId(key.id);
    revealKey.execute(key.id, {
      onFailure: () => setRevealingKeyId(undefined),
      onSuccess: (revealed) => {
        setRevealedKeys((current) => ({ ...current, [key.id]: revealed.key }));
        setVisibleKeyIds((current) => [...new Set([...current, key.id])]);
        setRevealingKeyId(undefined);
      },
    });
  };

  const errors = [
    keyQuery.state.status === "failure" ? keyQuery.state.error.message : undefined,
    createKey.state.error?.message,
    revealKey.state.error?.message,
    revokeKey.state.error?.message,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <>
      <ModalDialog
        aria-labelledby="settings-dialog-title"
        className={styles["dialog"]}
        data-settings-dialog=""
        onDismiss={onClose}
        open
      >
        <form data-settings-form="" onSubmit={submit}>
          <DialogHeader
            closeLabel="Close API keys"
            onClose={onClose}
            title="API keys"
            titleId="settings-dialog-title"
          />
          <p className={styles["note"]} data-settings-note="">
            Reuse an active key for the Inkling CLI and coding agents. Create another only when you
            need separate rotation or revocation. Keys have the same workspace permissions you do.
          </p>

          <section className={styles["list"]} aria-labelledby="api-key-list-title" data-api-keys="">
            <div className={styles["listHeading"]}>
              <div>
                <h3 id="api-key-list-title">Reusable access</h3>
                <p>Show and copy a key whenever you connect another agent.</p>
              </div>
              <span aria-label={`${activeKeys.length} active keys`}>{activeKeys.length}</span>
            </div>
            {keyQuery.state.status === "loading" && keys.length === 0 ? <p>Loading keys…</p> : null}
            {activeKeys.length === 0 && keyQuery.state.status !== "loading" ? (
              <p className={styles["listEmpty"]}>Create one key and reuse it across your agents.</p>
            ) : null}
            {activeKeys.map((key) => {
              const secret = revealedKeys[key.id];
              const visible = visibleKeyIds.includes(key.id) && secret !== undefined;
              return (
                <article className={styles["keyRow"]} data-api-key={key.id} key={key.id}>
                  <div className={styles["keySummary"]}>
                    <span>
                      <b>{key.label}</b>
                      <small>{keyActivity(key)}</small>
                    </span>
                    {visible ? (
                      <pre data-api-key-secret="">
                        <code>{secret}</code>
                      </pre>
                    ) : (
                      <code className={styles["maskedKey"]}>{key.id}.••••••••••••</code>
                    )}
                    {!key.revealable ? (
                      <small className={styles["legacyKey"]}>
                        This older key cannot be shown again. Replace it when convenient.
                      </small>
                    ) : null}
                  </div>
                  <div className={styles["keyActions"]}>
                    <Button
                      data-show-api-key={key.id}
                      disabled={!key.revealable || revealingKeyId === key.id}
                      onClick={() => toggleKey(key)}
                      variant="text"
                    >
                      {revealingKeyId === key.id ? "Showing…" : visible ? "Hide" : "Show"}
                    </Button>
                    {visible && secret !== undefined ? (
                      <Button
                        data-copy-api-key=""
                        onClick={() =>
                          copyKey.execute(secret, {
                            onSuccess: () => setCopiedKeyId(key.id),
                          })
                        }
                        variant="text"
                      >
                        {copiedKeyId === key.id ? "Copied" : "Copy API key"}
                      </Button>
                    ) : null}
                    <Button
                      data-revoke-key={key.id}
                      onClick={() => setKeyToRevoke(key)}
                      variant="text"
                    >
                      Revoke
                    </Button>
                  </div>
                </article>
              );
            })}
          </section>

          {createOpen ? (
            <section className={styles["create"]} aria-labelledby="api-key-create-title">
              <div>
                <h3 id="api-key-create-title">
                  {activeKeys.length === 0 ? "Create your API key" : "Create another API key"}
                </h3>
                <p>Use a separate key only when it needs its own revocation lifecycle.</p>
              </div>
              <div className={styles["createControls"]}>
                <TextField
                  label="Key name"
                  maxLength={200}
                  name="api-key-label"
                  onChange={(event) => setLabel(event.currentTarget.value)}
                  placeholder="Agent access"
                  value={label}
                />
                <Button disabled={createKey.state.pending} type="submit" variant="primary">
                  {createKey.state.pending ? "Creating…" : "Create API key"}
                </Button>
              </div>
              {activeKeys.length > 0 ? (
                <Button onClick={() => setCreateOpen(false)} variant="text">
                  Cancel
                </Button>
              ) : null}
            </section>
          ) : (
            <div className={styles["createPrompt"]}>
              <p>Need an independently revocable key?</p>
              <Button onClick={() => setCreateOpen(true)} variant="text">
                Create another key
              </Button>
            </div>
          )}

          <p className={styles["safety"]}>
            Store keys only in Inkling's user-only CLI configuration or a password manager. Never
            put one in AGENTS.md, an agent skill, chat, or source control.
          </p>
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
              setRevealedKeys((current) =>
                Object.fromEntries(Object.entries(current).filter(([id]) => id !== keyToRevoke.id)),
              );
              setVisibleKeyIds((current) => current.filter((id) => id !== keyToRevoke.id));
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
