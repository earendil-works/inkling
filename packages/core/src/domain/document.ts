declare const opaqueDocumentId: unique symbol;
declare const opaquePersonId: unique symbol;
declare const opaqueRevision: unique symbol;

export type DocumentId = string & { readonly [opaqueDocumentId]: true };
export type PersonId = string & { readonly [opaquePersonId]: true };
export type DocumentRevision = number & { readonly [opaqueRevision]: true };

export const knownLifecycleStates = [
  "draft",
  "discussion",
  "published",
  "accepted",
  "implemented",
  "abandoned",
] as const;

export type KnownLifecycleState = (typeof knownLifecycleStates)[number];
export type Visibility = "public" | "workspace";
export type Sensitivity = "normal" | "confidential";
export type CapabilityAccess = "disabled" | "view" | "comment" | "edit";

export interface PersonReference {
  readonly id: PersonId;
  readonly displayName: string;
  readonly email: string;
}

export interface RelatedDocumentReference {
  readonly documentId: DocumentId;
  readonly relationship?: string;
}

export interface SharingPolicy {
  readonly access: CapabilityAccess;
  readonly generation: number;
  readonly expiresAt?: string;
}

/** Security-sensitive metadata owned by a document authority, never by Markdown. */
export interface DocumentMetadata {
  readonly id: DocumentId;
  readonly rfcNumber?: number;
  readonly title: string;
  /** Unknown imported states are deliberately preserved. */
  readonly lifecycleState: KnownLifecycleState | (string & {});
  readonly visibility: Visibility;
  readonly sensitivity: Sensitivity;
  readonly labels: readonly string[];
  readonly authors: readonly PersonReference[];
  readonly reviewers: readonly PersonReference[];
  readonly approvers: readonly PersonReference[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly targetDecisionDate?: string;
  readonly relatedDocuments: readonly RelatedDocumentReference[];
  readonly legacySourceUrl?: string;
  readonly headRevision: DocumentRevision;
  readonly publishedRevision?: DocumentRevision;
  readonly sharing: SharingPolicy;
}
