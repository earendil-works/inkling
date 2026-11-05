import { Data, Effect } from "effect";

import type { CapabilityAccess, DocumentMetadata, PersonId } from "./document.ts";

export type WorkspaceRole = "member" | "administrator";

/** What a share link grants on the one document it was issued for. */
export interface CapabilityGrant {
  readonly documentId: string;
  readonly access: Exclude<CapabilityAccess, "disabled">;
  readonly expiresAt?: string | undefined;
  readonly generation: number;
}

export type Principal =
  | { readonly kind: "anonymous" }
  | {
      readonly displayName?: string | undefined;
      readonly kind: "workspace";
      readonly personId: PersonId;
      readonly role: WorkspaceRole;
      /** A share link the person opened; they act as themselves with its access added. */
      readonly capability?: CapabilityGrant | undefined;
      /**
       * Marks the application's own principal, which reads and maintains every
       * document, personal ones included. Credentials never resolve to it.
       */
      readonly system?: true | undefined;
    }
  | {
      readonly displayName?: string | undefined;
      readonly kind: "api-key";
      readonly keyId: string;
      readonly personId: PersonId;
      readonly role: WorkspaceRole;
      /** A share link the key's owner opened; see the workspace principal. */
      readonly capability?: CapabilityGrant | undefined;
    }
  | ({
      readonly kind: "capability";
      readonly guestId?: PersonId | undefined;
    } & CapabilityGrant);

export const documentActions = [
  "discover",
  "read-working",
  "read-published",
  "read-history",
  "comment",
  "edit-body",
  "edit-metadata",
  "manage-comments",
  "manage-sharing",
  "publish",
  "delete",
  "hard-delete",
  "restore",
  "restore-history",
  "move-to-workspace",
] as const;

export type DocumentAction = (typeof documentActions)[number];
export type WorkspaceAction = "administer-workspace" | "create-document" | "read-catalog";

export class AuthorizationError extends Data.TaggedError("AuthorizationError")<{
  readonly action: DocumentAction | WorkspaceAction;
  readonly message: string;
}> {}

export function authorizeDocument(
  principal: Principal,
  action: DocumentAction,
  metadata: DocumentMetadata,
  now: string,
): Effect.Effect<void, AuthorizationError> {
  const allowed = isDocumentActionAllowed(principal, action, metadata, now);
  return allowed
    ? Effect.void
    : Effect.fail(
        new AuthorizationError({
          action,
          message: `The current principal may not perform ${action} on this document.`,
        }),
      );
}

export function authorizeWorkspace(
  principal: Principal,
  action: WorkspaceAction,
): Effect.Effect<void, AuthorizationError> {
  const allowed =
    principal.kind === "workspace" || principal.kind === "api-key"
      ? action !== "administer-workspace" || principal.role === "administrator"
      : false;
  return allowed
    ? Effect.void
    : Effect.fail(
        new AuthorizationError({
          action,
          message: `The current principal may not perform ${action}.`,
        }),
      );
}

/**
 * Whether the principal may act on the document, either as who it is or
 * through the share link it carries, whichever allows more.
 */
export function isDocumentActionAllowed(
  principal: Principal,
  action: DocumentAction,
  metadata: DocumentMetadata,
  now: string,
): boolean {
  if (isIdentityActionAllowed(principal, action, metadata)) return true;
  const grant =
    principal.kind === "capability"
      ? principal
      : principal.kind === "workspace" || principal.kind === "api-key"
        ? principal.capability
        : undefined;
  return grant !== undefined && isGrantActionAllowed(grant, action, metadata, now);
}

function isIdentityActionAllowed(
  principal: Principal,
  action: DocumentAction,
  metadata: DocumentMetadata,
): boolean {
  if (metadata.personalOwner !== undefined && !isSystemPrincipal(principal)) {
    return isPersonalDocumentActionAllowed(principal, action, metadata);
  }
  if (action === "move-to-workspace") return false;

  if (metadata.deletedAt !== undefined) {
    if (principal.kind !== "workspace" && principal.kind !== "api-key") return false;
    switch (action) {
      case "comment":
      case "discover":
      case "edit-body":
      case "edit-metadata":
      case "read-history":
      case "read-working":
      case "restore-history":
        return true;
      case "delete":
      case "hard-delete":
      case "manage-comments":
      case "restore":
        return principal.role === "administrator";
      case "manage-sharing":
      case "publish":
      case "read-published":
        return false;
    }
  }

  if (principal.kind === "workspace" || principal.kind === "api-key") {
    if (action === "hard-delete") return false;
    if (
      action === "manage-comments" ||
      action === "manage-sharing" ||
      action === "delete" ||
      action === "restore"
    ) {
      return principal.role === "administrator";
    }
    return true;
  }

  if (principal.kind === "anonymous") {
    return (
      (action === "discover" || action === "read-published") &&
      metadata.visibility === "public" &&
      metadata.publishedRevision !== undefined
    );
  }
  return false;
}

function isGrantActionAllowed(
  grant: CapabilityGrant,
  action: DocumentAction,
  metadata: DocumentMetadata,
  now: string,
): boolean {
  if (
    metadata.deletedAt !== undefined ||
    grant.documentId !== metadata.id ||
    grant.generation !== metadata.sharing.generation ||
    metadata.sharing.access === "disabled" ||
    (grant.expiresAt !== undefined && Date.parse(grant.expiresAt) <= Date.parse(now))
  ) {
    return false;
  }

  switch (action) {
    case "discover":
    case "read-working":
      return true;
    case "comment":
      return grant.access === "comment" || grant.access === "edit";
    case "edit-body":
      return grant.access === "edit";
    case "read-published":
      return (
        metadata.visibility === "public" &&
        metadata.publishedRevision !== undefined &&
        metadata.personalOwner === undefined
      );
    case "delete":
    case "edit-metadata":
    case "hard-delete":
    case "manage-comments":
    case "manage-sharing":
    case "move-to-workspace":
    case "publish":
    case "read-history":
    case "restore":
    case "restore-history":
      return false;
  }
}

/**
 * Who may act on a personal document as themselves. Its owner manages it
 * like an administrator manages a workspace document, including sharing it
 * and deleting it permanently from the trash, but must move it to the
 * workspace before publishing it. People it is shared with read, comment on,
 * and edit it while it is not in the trash. Nobody else may, administrators
 * included; share links grant access separately.
 */
function isPersonalDocumentActionAllowed(
  principal: Principal,
  action: DocumentAction,
  metadata: DocumentMetadata,
): boolean {
  if (principal.kind !== "workspace" && principal.kind !== "api-key") return false;
  if (principal.personId !== metadata.personalOwner) {
    return (
      metadata.deletedAt === undefined &&
      (metadata.sharedWith ?? []).some((person) => person.id === principal.personId) &&
      isCollaboratorAction(action)
    );
  }
  switch (action) {
    case "publish":
    case "read-published":
      return false;
    case "hard-delete":
      return metadata.deletedAt !== undefined;
    case "move-to-workspace":
      return metadata.deletedAt === undefined;
    case "comment":
    case "delete":
    case "discover":
    case "edit-body":
    case "edit-metadata":
    case "manage-comments":
    case "manage-sharing":
    case "read-history":
    case "read-working":
    case "restore":
    case "restore-history":
      return true;
  }
}

function isCollaboratorAction(action: DocumentAction): boolean {
  switch (action) {
    case "comment":
    case "discover":
    case "edit-body":
    case "edit-metadata":
    case "read-history":
    case "read-working":
    case "restore-history":
      return true;
    case "delete":
    case "hard-delete":
    case "manage-comments":
    case "manage-sharing":
    case "move-to-workspace":
    case "publish":
    case "read-published":
    case "restore":
      return false;
  }
}

function isSystemPrincipal(principal: Principal): boolean {
  return principal.kind === "workspace" && principal.system === true;
}

export function isAdministrator(principal: Principal): boolean {
  return (
    (principal.kind === "workspace" || principal.kind === "api-key") &&
    principal.role === "administrator"
  );
}
