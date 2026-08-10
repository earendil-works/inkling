import { Data, Effect } from "effect";

import type { CapabilityAccess, DocumentMetadata, PersonId } from "./document.ts";

export type WorkspaceRole = "member" | "administrator";

export type Principal =
  | { readonly kind: "anonymous" }
  | {
      readonly displayName?: string | undefined;
      readonly kind: "workspace";
      readonly personId: PersonId;
      readonly role: WorkspaceRole;
    }
  | {
      readonly displayName?: string | undefined;
      readonly kind: "api-key";
      readonly keyId: string;
      readonly personId: PersonId;
      readonly role: WorkspaceRole;
    }
  | {
      readonly kind: "capability";
      readonly documentId: string;
      readonly access: Exclude<CapabilityAccess, "disabled">;
      readonly expiresAt?: string | undefined;
      readonly generation: number;
      readonly guestId?: PersonId | undefined;
    };

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

export function isDocumentActionAllowed(
  principal: Principal,
  action: DocumentAction,
  metadata: DocumentMetadata,
  now: string,
): boolean {
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

  if (
    principal.documentId !== metadata.id ||
    principal.generation !== metadata.sharing.generation ||
    metadata.sharing.access === "disabled" ||
    (principal.expiresAt !== undefined && Date.parse(principal.expiresAt) <= Date.parse(now))
  ) {
    return false;
  }

  switch (action) {
    case "discover":
    case "read-working":
      return true;
    case "comment":
      return principal.access === "comment" || principal.access === "edit";
    case "edit-body":
      return principal.access === "edit";
    case "read-published":
      return metadata.visibility === "public" && metadata.publishedRevision !== undefined;
    case "delete":
    case "edit-metadata":
    case "hard-delete":
    case "manage-comments":
    case "manage-sharing":
    case "publish":
    case "read-history":
    case "restore":
    case "restore-history":
      return false;
  }
}

export function isAdministrator(principal: Principal): boolean {
  return (
    (principal.kind === "workspace" || principal.kind === "api-key") &&
    principal.role === "administrator"
  );
}
