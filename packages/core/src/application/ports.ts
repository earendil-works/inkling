import { Context, Data, type Effect } from "effect";

import type { DocumentId, DocumentRevision } from "../domain/document.ts";

export class StorageError extends Data.TaggedError("StorageError")<{
  readonly operation: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly cause?: unknown;
}> {}

export interface StoredObject {
  readonly bytes: Uint8Array;
  readonly digest: string;
  readonly mediaType?: string | undefined;
}

export interface PutObjectOptions {
  readonly digest: string;
  readonly mediaType?: string | undefined;
}

/** Portable storage for checkpoints, projections, artifacts, and attachments. */
export interface ObjectStoreService {
  readonly get: (key: string) => Effect.Effect<StoredObject | undefined, StorageError>;
  readonly put: (
    key: string,
    bytes: Uint8Array,
    options: PutObjectOptions,
  ) => Effect.Effect<void, StorageError>;
  readonly delete: (key: string) => Effect.Effect<void, StorageError>;
  readonly list: (prefix: string) => Effect.Effect<readonly string[], StorageError>;
}

export const ObjectStore = Context.GenericTag<ObjectStoreService>(
  "@earendil-works/jot/ObjectStore",
);

export type JournalEntryKind =
  | "body-update"
  | "metadata-event"
  | "comment-event"
  | "sharing-event"
  | "publication-event";

export interface JournalEntryInput {
  readonly documentId: DocumentId;
  readonly revision: DocumentRevision;
  readonly kind: JournalEntryKind;
  readonly payload: Uint8Array;
  readonly idempotencyKey?: string | undefined;
}

export interface JournalEntry extends JournalEntryInput {
  readonly sequence: number;
}

/** Append resolves only after the record is durable. */
export interface DurableDocumentJournalService {
  readonly append: (entry: JournalEntryInput) => Effect.Effect<JournalEntry, StorageError>;
  readonly entriesAfter: (
    documentId: DocumentId,
    sequence: number,
  ) => Effect.Effect<readonly JournalEntry[], StorageError>;
  readonly truncateThrough: (
    documentId: DocumentId,
    sequence: number,
  ) => Effect.Effect<void, StorageError>;
}

export const DurableDocumentJournal = Context.GenericTag<DurableDocumentJournalService>(
  "@earendil-works/jot/DurableDocumentJournal",
);

export interface WorkspaceStateStoreService {
  readonly load: <A>() => Effect.Effect<A | undefined, StorageError>;
  readonly save: <A>(state: A) => Effect.Effect<void, StorageError>;
}

export const WorkspaceStateStore = Context.GenericTag<WorkspaceStateStoreService>(
  "@earendil-works/jot/WorkspaceStateStore",
);

export interface IdGeneratorService {
  readonly generate: (purpose: string) => Effect.Effect<string>;
}

export const IdGenerator = Context.GenericTag<IdGeneratorService>(
  "@earendil-works/jot/IdGenerator",
);

export interface DigestService {
  readonly sha256: (bytes: Uint8Array) => Effect.Effect<string, StorageError>;
}

export const Digest = Context.GenericTag<DigestService>("@earendil-works/jot/Digest");

export interface SecretHasherService {
  readonly hash: (secret: string) => Effect.Effect<string, StorageError>;
  readonly verify: (secret: string, encodedHash: string) => Effect.Effect<boolean, StorageError>;
}

export const SecretHasher = Context.GenericTag<SecretHasherService>(
  "@earendil-works/jot/SecretHasher",
);

export interface SecureTokenService {
  readonly generate: (byteLength: number) => Effect.Effect<string, StorageError>;
}

export const SecureToken = Context.GenericTag<SecureTokenService>(
  "@earendil-works/jot/SecureToken",
);
