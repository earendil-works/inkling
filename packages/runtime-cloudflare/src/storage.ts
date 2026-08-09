import { Effect } from "effect";

import { StorageError } from "@earendil-works/inkling-core";
import type {
  DigestService,
  DurableDocumentJournalService,
  JournalEntry,
  ObjectStoreService,
  StoredObject,
  WorkspaceStateStoreService,
} from "@earendil-works/inkling-core";

export function makeDurableWorkspaceStateStore(
  storage: DurableObjectStorage,
): WorkspaceStateStoreService {
  return {
    load: <A>() => cloudflareCall("load workspace state", () => storage.get<A>("workspace:state")),
    save: <A>(state: A) =>
      cloudflareCall("save workspace state", () => storage.put("workspace:state", state)),
  };
}

export function makeR2ObjectStore(bucket: R2Bucket): ObjectStoreService {
  return {
    delete: (key) => cloudflareCall("delete R2 object", () => bucket.delete(key)),
    get: (key) =>
      cloudflareCall("read R2 object", () => bucket.get(key)).pipe(
        Effect.flatMap((object) => {
          if (object === null) return Effect.succeed(undefined);
          return cloudflareCall("read R2 object body", () => object.arrayBuffer()).pipe(
            Effect.map((body): StoredObject => ({
              bytes: new Uint8Array(body),
              digest: object.customMetadata?.["digest"] ?? object.etag,
              mediaType: object.httpMetadata?.contentType,
            })),
          );
        }),
      ),
    list: (prefix) =>
      Effect.gen(function* () {
        const keys: string[] = [];
        let cursor: string | undefined;
        do {
          const page = yield* cloudflareCall("list R2 objects", () =>
            bucket.list({ ...(cursor === undefined ? {} : { cursor }), prefix }),
          );
          keys.push(...page.objects.map((object) => object.key));
          cursor = page.truncated ? page.cursor : undefined;
        } while (cursor !== undefined);
        return keys.toSorted();
      }),
    put: (key, bytes, options) =>
      cloudflareCall("write R2 object", () =>
        bucket.put(key, bytes, {
          customMetadata: { digest: options.digest },
          ...(options.mediaType === undefined
            ? {}
            : { httpMetadata: { contentType: options.mediaType } }),
        }),
      ).pipe(Effect.asVoid),
  };
}

export const WebCryptoDigest: DigestService = {
  sha256: (bytes) =>
    cloudflareCall("calculate SHA-256", () =>
      crypto.subtle.digest("SHA-256", new Uint8Array(bytes)),
    ).pipe(Effect.map((digest) => hex(new Uint8Array(digest)))),
};

export function makeDurableObjectJournal(
  storage: DurableObjectStorage,
): DurableDocumentJournalService {
  return {
    append: (input) =>
      cloudflareCall("append Durable Object journal", () =>
        storage.transaction(async (transaction) => {
          if (input.idempotencyKey !== undefined) {
            const existingSequence = await transaction.get<number>(
              idempotencyKey(input.documentId, input.idempotencyKey),
            );
            if (existingSequence !== undefined) {
              const existing = await transaction.get<JournalEntry>(
                journalKey(input.documentId, existingSequence),
              );
              if (existing !== undefined) return existing;
            }
          }
          const sequenceKey = journalSequenceKey(input.documentId);
          const current = (await transaction.get<number>(sequenceKey)) ?? input.previousSequence;
          if (current !== input.previousSequence) {
            throw new Error(
              `Journal sequence mismatch: authority=${input.previousSequence}, storage=${current}`,
            );
          }
          const entry: JournalEntry = { ...input, sequence: input.previousSequence + 1 };
          await transaction.put(journalKey(input.documentId, entry.sequence), entry);
          await transaction.put(sequenceKey, entry.sequence);
          if (input.idempotencyKey !== undefined) {
            await transaction.put(
              idempotencyKey(input.documentId, input.idempotencyKey),
              entry.sequence,
            );
          }
          return entry;
        }),
      ),
    entriesAfter: (documentId, sequence) =>
      cloudflareCall("read Durable Object journal", () =>
        storage.list<JournalEntry>({
          prefix: journalPrefix(documentId),
          start: journalKey(documentId, sequence + 1),
        }),
      ).pipe(
        Effect.map((entries) =>
          [...entries.values()].toSorted((left, right) => left.sequence - right.sequence),
        ),
      ),
    delete: (documentId) =>
      cloudflareCall("delete Durable Object journal", async () => {
        const [journalEntries, idempotencyEntries] = await Promise.all([
          storage.list({ prefix: `journal:${documentId}:` }),
          storage.list({ prefix: `idempotency:${documentId}:` }),
        ]);
        const keys = [...journalEntries.keys(), ...idempotencyEntries.keys()];
        if (keys.length > 0) await storage.delete(keys);
      }),
    truncateThrough: (documentId, sequence) =>
      cloudflareCall("truncate Durable Object journal", async () => {
        const entries = await storage.list<JournalEntry>({
          end: journalKey(documentId, sequence + 1),
          prefix: journalPrefix(documentId),
        });
        const keys: string[] = [];
        for (const [key, entry] of entries) {
          keys.push(key);
          if (entry.idempotencyKey !== undefined) {
            keys.push(idempotencyKey(documentId, entry.idempotencyKey));
          }
        }
        if (keys.length > 0) await storage.delete(keys);
      }),
  };
}

function journalPrefix(documentId: string): string {
  return `journal:${documentId}:entry:`;
}

function journalKey(documentId: string, sequence: number): string {
  return `${journalPrefix(documentId)}${String(sequence).padStart(16, "0")}`;
}

function journalSequenceKey(documentId: string): string {
  return `journal:${documentId}:sequence`;
}

function idempotencyKey(documentId: string, value: string): string {
  return `idempotency:${documentId}:${value.replace(/[^A-Za-z0-9_-]/gu, "_").slice(0, 180)}`;
}

function cloudflareCall<A>(
  operation: string,
  run: () => Promise<A>,
): Effect.Effect<A, StorageError> {
  return Effect.tryPromise({
    catch: (cause) =>
      new StorageError({
        cause,
        message: `Cloudflare storage failed while attempting to ${operation}.`,
        operation,
        retryable: true,
      }),
    try: run,
  });
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}
