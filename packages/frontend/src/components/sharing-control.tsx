import { useEffect, useState } from "react";
import { Effect } from "effect";

import type {
  ShareLinkDto,
  ShareLinksResponse,
  SharingPolicyDto,
} from "@earendil-works/inkling-protocol";

import type { ApiClientService, ApiError } from "../api.ts";
import { useAppContext } from "../app-context.tsx";
import { useEffectAction, useEffectQuery } from "../effect-hooks.ts";
import { browserRuntime } from "../effect-runtime.ts";
import { formatDate } from "../ui.ts";
import { Button } from "./button.tsx";
import { CheckboxField } from "./checkbox-field.tsx";
import { DialogHeader } from "./dialog-header.tsx";
import { FormError } from "./form-error.tsx";
import { ModalDialog } from "./modal-dialog.tsx";
import { SelectField } from "./select-field.tsx";
import styles from "./sharing-control.module.css";
import { TextField } from "./text-field.tsx";

type ShareAccess = "view" | "comment" | "edit";
type ShareAction =
  | {
      readonly access: ShareAccess;
      readonly password?: string | undefined;
      readonly type: "create";
    }
  | { readonly id: string; readonly type: "delete" };

export interface SharingControlProps {
  readonly access: SharingPolicyDto["access"];
  readonly api: ApiClientService;
  readonly documentId: string;
  readonly onUpdated: (response: ShareLinksResponse) => void;
}

export function SharingControl({
  access,
  api,
  documentId,
  onUpdated,
}: SharingControlProps): React.JSX.Element {
  const { showToast } = useAppContext();
  const [open, setOpen] = useState(false);
  const [selectedAccess, setSelectedAccess] = useState<ShareAccess>(
    access === "disabled" ? "view" : access,
  );
  const [passwordProtected, setPasswordProtected] = useState(false);
  const [password, setPassword] = useState("");
  const linksQuery = useEffectQuery(
    open ? api.listShareLinks(documentId) : Effect.succeed(undefined),
    `share-links:${documentId}:${open ? "open" : "closed"}`,
  );
  const links = linksQuery.state.data?.links ?? [];
  const shareAction = useEffectAction<ShareAction, ShareLinksResponse, ApiError>((action) =>
    api.listShareLinks(documentId).pipe(
      Effect.flatMap((current) =>
        action.type === "create"
          ? api.createShareLink(documentId, {
              access: action.access,
              expectedRevision: current.revision,
              password: action.password,
            })
          : api.deleteShareLink(documentId, action.id, current.revision),
      ),
    ),
  );

  useEffect(() => {
    if (access !== "disabled") setSelectedAccess(access);
  }, [access]);

  const duplicateConfiguration = links.some(
    (link) => link.access === selectedAccess && link.passwordProtected === passwordProtected,
  );
  const pending = shareAction.state.pending;
  const dismiss = (): void => {
    if (!pending) setOpen(false);
  };
  const applyResponse = (response: ShareLinksResponse): void => {
    onUpdated(response);
    linksQuery.refresh();
  };

  return (
    <>
      <Button variant="toolbar" data-share="" onClick={() => setOpen(true)}>
        Share
      </Button>
      <ModalDialog
        aria-labelledby="sharing-dialog-title"
        className={styles["dialog"]}
        onDismiss={dismiss}
        open={open}
        preventDismiss={pending}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (duplicateConfiguration || (passwordProtected && password.length < 8)) return;
            const previousIds = new Set(links.map((link) => link.id));
            shareAction.execute(
              {
                access: selectedAccess,
                password: passwordProtected ? password : undefined,
                type: "create",
              },
              {
                onSuccess: (response) => {
                  applyResponse(response);
                  const created = response.links.find((link) => !previousIds.has(link.id));
                  if (created?.url !== undefined) copyShareUrl(created.url);
                  setPassword("");
                  showToast("Share link created and copied.", "success");
                },
              },
            );
          }}
        >
          <DialogHeader
            closeLabel="Close sharing settings"
            disabled={pending}
            eyebrow="Capability access"
            onClose={dismiss}
            title="Share document"
            titleId="sharing-dialog-title"
          />

          <section className={styles["linkList"]} aria-labelledby="share-link-list-title">
            <div className={styles["listHeading"]}>
              <h3 id="share-link-list-title">Active links</h3>
              <span>{links.length}</span>
            </div>
            {linksQuery.state.status === "loading" && links.length === 0 ? (
              <p className={styles["listEmpty"]}>Loading share links…</p>
            ) : links.length === 0 ? (
              <p className={styles["listEmpty"]}>This document has no share links.</p>
            ) : (
              links.map((link) => (
                <ShareLinkRow
                  disabled={pending}
                  key={link.id}
                  link={link}
                  onCopy={(url) => {
                    copyShareUrl(url);
                    showToast("Share link copied.", "success");
                  }}
                  onDelete={(id) =>
                    shareAction.execute(
                      { id, type: "delete" },
                      {
                        onSuccess: (response) => {
                          applyResponse(response);
                          showToast("Share link deleted.", "success");
                        },
                      },
                    )
                  }
                />
              ))
            )}
            {linksQuery.state.status === "failure" ? (
              <FormError>{linksQuery.state.error.message}</FormError>
            ) : null}
          </section>

          <section className={styles["linkCreate"]} aria-labelledby="share-link-create-title">
            <h3 id="share-link-create-title">Create a link</h3>
            <SelectField
              label="Anyone with this link can"
              onChange={(event) => {
                const value = event.currentTarget.value;
                if (isShareAccess(value)) setSelectedAccess(value);
              }}
              value={selectedAccess}
            >
              <option value="view">View</option>
              <option value="comment">View and comment</option>
              <option value="edit">View, comment, and edit</option>
            </SelectField>
            <CheckboxField
              checked={passwordProtected}
              label="Require a password"
              onChange={(event) => setPasswordProtected(event.currentTarget.checked)}
            />
            {passwordProtected ? (
              <TextField
                autoComplete="new-password"
                label="Password"
                minLength={8}
                onChange={(event) => setPassword(event.currentTarget.value)}
                required
                type="password"
                value={password}
              />
            ) : null}
            {duplicateConfiguration ? (
              <p className={styles["note"]} data-share-duplicate="">
                A link with this access and protection already exists.
              </p>
            ) : null}
            <Button
              disabled={
                pending ||
                linksQuery.state.status === "loading" ||
                duplicateConfiguration ||
                (passwordProtected && password.length < 8)
              }
              type="submit"
              variant="primary"
            >
              {pending ? "Updating…" : "Create and copy link"}
            </Button>
          </section>
          <FormError>{shareAction.state.error?.message}</FormError>
        </form>
      </ModalDialog>
    </>
  );
}

function ShareLinkRow({
  disabled,
  link,
  onCopy,
  onDelete,
}: {
  readonly disabled: boolean;
  readonly link: ShareLinkDto;
  readonly onCopy: (url: string) => void;
  readonly onDelete: (id: string) => void;
}): React.JSX.Element {
  return (
    <div className={styles["linkRow"]} data-share-link={link.id}>
      <span>
        <b>{accessLabel(link.access)}</b>
        <small>
          {link.passwordProtected ? "Password protected" : "No password"} · Created{" "}
          {formatDate(link.createdAt)}
        </small>
        {link.url === undefined ? (
          <small>Created before retained links; its URL cannot be shown again.</small>
        ) : null}
      </span>
      <div className={styles["rowActions"]}>
        {link.url === undefined ? null : (
          <Button
            aria-label={`Copy ${accessLabel(link.access).toLocaleLowerCase("en")} share link`}
            disabled={disabled}
            onClick={() => onCopy(link.url ?? "")}
            variant="text"
          >
            Copy
          </Button>
        )}
        <Button
          aria-label={`Delete ${accessLabel(link.access).toLocaleLowerCase("en")} share link`}
          className={styles["delete"]}
          disabled={disabled}
          onClick={() => onDelete(link.id)}
          variant="text"
        >
          Delete
        </Button>
      </div>
    </div>
  );
}

function copyShareUrl(url: string): void {
  browserRuntime.runFork(
    Effect.tryPromise({
      catch: () => undefined,
      try: () => navigator.clipboard.writeText(url),
    }).pipe(Effect.ignore),
  );
}

function accessLabel(access: ShareAccess): string {
  switch (access) {
    case "view":
      return "Can view";
    case "comment":
      return "Can comment";
    case "edit":
      return "Can edit";
  }
}

function isShareAccess(value: string): value is ShareAccess {
  return value === "view" || value === "comment" || value === "edit";
}
