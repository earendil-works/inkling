import type { DocumentId, DocumentRevision } from "../domain/document.ts";

export interface StoredObject {
  readonly bytes: Uint8Array;
  readonly digest: string;
  readonly mediaType?: string;
}

export interface PutObjectOptions {
  readonly digest: string;
  readonly mediaType?: string;
}

/** Portable storage for checkpoints, projections, artifacts, and attachments. */
export interface ObjectStore {
  get(key: string): Promise<StoredObject | undefined>;
  put(key: string, bytes: Uint8Array, options: PutObjectOptions): Promise<void>;
  delete(key: string): Promise<void>;
}

export type JournalEntryKind = "body-update" | "metadata-event" | "comment-event";

export interface JournalEntryInput {
  readonly documentId: DocumentId;
  readonly revision: DocumentRevision;
  readonly kind: JournalEntryKind;
  readonly payload: Uint8Array;
}

export interface JournalEntry extends JournalEntryInput {
  readonly sequence: number;
}

/**
 * The append promise may resolve only after the entry is durable. Authorities must
 * await it before acknowledging or broadcasting the corresponding operation.
 */
export interface DurableDocumentJournal {
  append(entry: JournalEntryInput): Promise<JournalEntry>;
  entriesAfter(sequence: number): Promise<readonly JournalEntry[]>;
  truncateThrough(sequence: number): Promise<void>;
}
