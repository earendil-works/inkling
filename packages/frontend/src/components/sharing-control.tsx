import { useEffect, useState } from "react";
import { Effect } from "effect";

import { ShareIcon } from "@earendil-works/elanor-icons-react";
import {
  Button,
  Checkbox,
  ControlAndLabel,
  Fieldset,
  Form,
  Heading,
  Input,
  Radio,
  SelectionControlAndLabel,
  Separator,
  Stack,
  Text,
} from "@earendil-works/elanor-react";
import type {
  DocumentMetadataDto,
  PersonDto,
  ShareLinkDto,
  ShareLinksResponse,
  SharingPolicyDto,
} from "@earendil-works/inkling-protocol";

import type { ApiClientService, ApiError } from "../api.ts";
import { useAppContext } from "../app-context.tsx";
import { copyText } from "../clipboard.ts";
import type { ClipboardError } from "../clipboard.ts";
import { useEffectAction, useEffectQuery } from "../effect-hooks.ts";
import { formatDate } from "../ui.ts";
import { Dialog } from "./dialog.tsx";
import { FormError } from "./form-error.tsx";
import styles from "./sharing-control.module.css";

type ShareAccess = "view" | "comment" | "edit";
type ShareAction =
  | {
      readonly access: ShareAccess;
      readonly password?: string | undefined;
      readonly type: "create";
    }
  | { readonly id: string; readonly type: "delete" };

const accessOptions: readonly { readonly label: string; readonly value: ShareAccess }[] = [
  { label: "View", value: "view" },
  { label: "View and comment", value: "comment" },
  { label: "View, comment, and edit", value: "edit" },
];

export interface SharingControlProps {
  readonly access: SharingPolicyDto["access"];
  readonly api: ApiClientService;
  readonly documentId: string;
  readonly onUpdated: (response: ShareLinksResponse) => void;
  /** Personal documents are also shared with named people. */
  readonly personal?:
    | {
        readonly onPeopleChanged: (metadata: DocumentMetadataDto) => void;
        readonly people: readonly PersonDto[];
      }
    | undefined;
}

export function SharingControl({
  access,
  api,
  documentId,
  onUpdated,
  personal,
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
  const copy = useEffectAction<string, void, ClipboardError>(copyText);
  const copyLink = (url: string, copiedMessage: string): void =>
    copy.execute(url, {
      onFailure: (error) => showToast(error.message, "error"),
      onSuccess: () => showToast(copiedMessage, "success"),
    });
  const applyResponse = (response: ShareLinksResponse): void => {
    onUpdated(response);
    linksQuery.refresh();
  };

  return (
    <>
      <Button
        data-share=""
        hierarchy="tertiary"
        iconStart={<ShareIcon />}
        onClick={() => setOpen(true)}
      >
        Share
      </Button>
      <Dialog
        closeLabel="Close sharing settings"
        description={
          personal === undefined
            ? "Links grant access to the working draft without a workspace account."
            : "Only you and the people and links below can open this personal document. Signed-in people who open a link appear as themselves."
        }
        onClose={() => setOpen(false)}
        open={open}
        pending={pending}
        title={personal === undefined ? "Share document" : "Share personal document"}
      >
        <Stack align="stretch" gap="large">
          {personal === undefined ? null : (
            <>
              <SharedPeople
                api={api}
                documentId={documentId}
                onChanged={personal.onPeopleChanged}
                people={personal.people}
              />
              <Separator />
            </>
          )}
          <section aria-labelledby="share-link-list-title" className={styles["section"]}>
            <Stack align="center" direction="row" gap="auto">
              <Heading id="share-link-list-title" level={3}>
                Active links
              </Heading>
              <span className={styles["count"]}>{links.length}</span>
            </Stack>
            {linksQuery.state.status === "loading" && links.length === 0 ? (
              <Text className={styles["note"]}>Loading share links…</Text>
            ) : links.length === 0 ? (
              <Text className={styles["note"]}>This document has no share links.</Text>
            ) : (
              <ul className={styles["links"]}>
                {links.map((link) => (
                  <ShareLinkRow
                    disabled={pending}
                    key={link.id}
                    link={link}
                    onCopy={(url) => copyLink(url, "Share link copied.")}
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
                ))}
              </ul>
            )}
            {linksQuery.state.status === "failure" ? (
              <FormError>{linksQuery.state.error.message}</FormError>
            ) : null}
          </section>

          <Separator />

          <Form
            aria-labelledby="share-link-create-title"
            className={styles["section"]}
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
                    setPassword("");
                    if (created?.url === undefined) showToast("Share link created.", "success");
                    else copyLink(created.url, "Share link created and copied.");
                  },
                },
              );
            }}
          >
            <Heading id="share-link-create-title" level={3}>
              Create a link
            </Heading>
            <Fieldset.Root
              render={
                <Radio.Group
                  onValueChange={(value) => {
                    if (isShareAccess(value)) setSelectedAccess(value);
                  }}
                  value={selectedAccess}
                />
              }
            >
              <Fieldset.Legend>Anyone with this link can</Fieldset.Legend>
              <Stack gap="small">
                {accessOptions.map((option) => (
                  <SelectionControlAndLabel
                    control={
                      <Radio.Root value={option.value}>
                        <Radio.Indicator />
                      </Radio.Root>
                    }
                    key={option.value}
                  >
                    {option.label}
                  </SelectionControlAndLabel>
                ))}
              </Stack>
            </Fieldset.Root>
            <SelectionControlAndLabel
              control={
                <Checkbox.Root checked={passwordProtected} onCheckedChange={setPasswordProtected}>
                  <Checkbox.Indicator />
                </Checkbox.Root>
              }
            >
              Require a password
            </SelectionControlAndLabel>
            {passwordProtected ? (
              <ControlAndLabel
                description="At least eight characters."
                error="Enter at least eight characters."
                label="Password"
              >
                <Input
                  autoComplete="new-password"
                  minLength={8}
                  onValueChange={setPassword}
                  required
                  type="password"
                  value={password}
                />
              </ControlAndLabel>
            ) : null}
            {duplicateConfiguration ? (
              <Text className={styles["note"]} data-share-duplicate="">
                A link with this access and protection already exists.
              </Text>
            ) : null}
            <FormError>{shareAction.state.error?.message}</FormError>
            <div>
              <Button
                disabled={
                  linksQuery.state.status === "loading" ||
                  duplicateConfiguration ||
                  (passwordProtected && password.length < 8)
                }
                pending={pending}
                type="submit"
              >
                Create and copy link
              </Button>
            </div>
          </Form>
        </Stack>
      </Dialog>
    </>
  );
}

/** The people a personal document is shared with, by email. */
function SharedPeople({
  api,
  documentId,
  onChanged,
  people,
}: {
  readonly api: ApiClientService;
  readonly documentId: string;
  readonly onChanged: (metadata: DocumentMetadataDto) => void;
  readonly people: readonly PersonDto[];
}): React.JSX.Element {
  const { showToast } = useAppContext();
  const [email, setEmail] = useState("");
  // The revision moves with every edit, so the change reads it right before applying.
  const update = useEffectAction<readonly string[], DocumentMetadataDto, ApiError>((emails) =>
    api
      .listShareLinks(documentId)
      .pipe(
        Effect.flatMap((current) =>
          api.sharePersonalDocument(documentId, emails, current.revision),
        ),
      ),
  );
  const normalized = email.trim().toLocaleLowerCase("en");
  const alreadyShared = people.some(
    (person) => person.email.toLocaleLowerCase("en") === normalized,
  );

  return (
    <section aria-labelledby="share-people-title" className={styles["section"]}>
      <Stack align="center" direction="row" gap="auto">
        <Heading id="share-people-title" level={3}>
          People
        </Heading>
        <span className={styles["count"]}>{people.length}</span>
      </Stack>
      {people.length === 0 ? (
        <Text className={styles["note"]}>Nobody else can open this document yet.</Text>
      ) : (
        <ul className={styles["links"]}>
          {people.map((person) => (
            <li className={styles["link"]} data-shared-person={person.email} key={person.id}>
              <Stack gap="xxSmall">
                <strong className={styles["linkLabel"]}>{person.displayName}</strong>
                {person.displayName === person.email ? null : (
                  <Text className={styles["meta"]}>{person.email}</Text>
                )}
              </Stack>
              <Button
                aria-label={`Stop sharing with ${person.displayName}`}
                density="compact"
                disabled={update.state.pending}
                hierarchy="tertiary"
                onClick={() =>
                  update.execute(
                    people
                      .filter((candidate) => candidate.id !== person.id)
                      .map((candidate) => candidate.email),
                    {
                      onSuccess: (metadata) => {
                        onChanged(metadata);
                        showToast(`Stopped sharing with ${person.displayName}.`, "success");
                      },
                    },
                  )
                }
                semantic="negative"
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      <Form
        aria-labelledby="share-people-title"
        className={styles["section"]}
        data-share-people-form=""
        onSubmit={(event) => {
          event.preventDefault();
          if (normalized === "" || alreadyShared) return;
          update.execute([...people.map((person) => person.email), normalized], {
            onSuccess: (metadata) => {
              onChanged(metadata);
              setEmail("");
              showToast("Document shared.", "success");
            },
          });
        }}
      >
        <ControlAndLabel
          description="They can find, read, comment on, and edit it, but not share it further."
          label="Share with"
        >
          <Input
            autoComplete="email"
            name="share-email"
            onValueChange={setEmail}
            placeholder="name@example.com"
            required
            type="email"
            value={email}
          />
        </ControlAndLabel>
        {alreadyShared ? (
          <Text className={styles["note"]}>This document is already shared with them.</Text>
        ) : null}
        <FormError>{update.state.error?.message}</FormError>
        <div>
          <Button
            disabled={normalized === "" || alreadyShared}
            pending={update.state.pending}
            type="submit"
          >
            Share
          </Button>
        </div>
      </Form>
    </section>
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
  const label = accessLabel(link.access);
  return (
    <li className={styles["link"]} data-share-link={link.id}>
      <Stack gap="xxSmall">
        <strong className={styles["linkLabel"]}>{label}</strong>
        <Text className={styles["meta"]}>
          {link.passwordProtected ? "Password protected" : "No password"} · Created{" "}
          {formatDate(link.createdAt)}
        </Text>
        {link.url === undefined ? (
          <Text className={styles["meta"]}>
            Created before retained links; its URL cannot be shown again.
          </Text>
        ) : null}
      </Stack>
      <Stack direction="row" gap="xSmall">
        {link.url === undefined ? null : (
          <Button
            aria-label={`Copy ${label.toLocaleLowerCase("en")} share link`}
            density="compact"
            disabled={disabled}
            hierarchy="secondary"
            onClick={() => onCopy(link.url ?? "")}
          >
            Copy
          </Button>
        )}
        <Button
          aria-label={`Delete ${label.toLocaleLowerCase("en")} share link`}
          density="compact"
          disabled={disabled}
          hierarchy="tertiary"
          onClick={() => onDelete(link.id)}
          semantic="negative"
        >
          Delete
        </Button>
      </Stack>
    </li>
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

function isShareAccess(value: unknown): value is ShareAccess {
  return value === "view" || value === "comment" || value === "edit";
}
