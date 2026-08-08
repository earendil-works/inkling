import path from "node:path";

import { FileSystem } from "@effect/platform";
import { Effect, Layer, Schema } from "effect";

import {
  Digest,
  DurableDocumentJournal,
  identifierTag,
  ObjectStore,
  StorageError,
  taggedId,
  uuidV7Bytes,
  WorkspaceStateStore,
} from "@earendil-works/inkling-core";
import type {
  DigestService,
  DurableDocumentJournalService,
  JournalEntry,
  ObjectStoreService,
  StoredObject,
  WorkspaceStateStoreService,
} from "@earendil-works/inkling-core";
import { decodeBase64, encodeBase64 } from "@earendil-works/inkling-collaboration";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const objectMetadataSchema = Schema.Struct({
  digest: Schema.String,
  mediaType: Schema.optional(Schema.String),
});

const journalRecordSchema = Schema.Struct({
  checksum: Schema.String,
  documentId: Schema.String,
  idempotencyKey: Schema.optional(Schema.String),
  kind: Schema.Literal(
    "body-update",
    "metadata-event",
    "comment-event",
    "sharing-event",
    "publication-event",
  ),
  payload: Schema.String,
  revision: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  sequence: Schema.Number.pipe(Schema.int(), Schema.positive()),
});

type JournalRecord = typeof journalRecordSchema.Type;

export function objectStoreLayer(
  dataDirectory: string,
): Layer.Layer<ObjectStoreService, never, FileSystem.FileSystem | DigestService> {
  return Layer.effect(
    ObjectStore,
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const digest = yield* Digest;
      const root = path.join(dataDirectory, "objects");
      const metadataRoot = path.join(dataDirectory, "object-metadata");
      yield* Effect.forEach([root, metadataRoot], (directory) =>
        fileSystem.makeDirectory(directory, { recursive: true }).pipe(
          Effect.mapError(() => undefined),
          Effect.catchAll(() => Effect.void),
        ),
      );

      const metadataPath = (key: string) => safePath(metadataRoot, `${key}.json`);
      const service: ObjectStoreService = {
        delete: (key) =>
          Effect.all([safePath(root, key), metadataPath(key)]).pipe(
            Effect.flatMap(([filePath, sidecarPath]) =>
              Effect.forEach([filePath, sidecarPath], (target) =>
                fileSystem
                  .remove(target, { force: true })
                  .pipe(Effect.mapError((cause) => storageFailure("delete object", cause))),
              ),
            ),
            Effect.asVoid,
          ),
        get: (key) =>
          Effect.all([safePath(root, key), metadataPath(key)]).pipe(
            Effect.flatMap(([filePath, sidecarPath]) =>
              fileSystem.exists(filePath).pipe(
                Effect.mapError((cause) => storageFailure("inspect object", cause)),
                Effect.flatMap((exists) =>
                  exists
                    ? Effect.all({
                        bytes: fileSystem
                          .readFile(filePath)
                          .pipe(Effect.mapError((cause) => storageFailure("read object", cause))),
                        metadata: readObjectMetadata(fileSystem, sidecarPath),
                      }).pipe(
                        Effect.flatMap(({ bytes, metadata }) =>
                          metadata === undefined
                            ? digest.sha256(bytes).pipe(
                                Effect.map((objectDigest): StoredObject => ({
                                  bytes,
                                  digest: objectDigest,
                                  mediaType: mediaTypeForKey(key),
                                })),
                              )
                            : Effect.succeed({
                                bytes,
                                digest: metadata.digest,
                                mediaType: metadata.mediaType ?? mediaTypeForKey(key),
                              }),
                        ),
                      )
                    : Effect.succeed(undefined),
                ),
              ),
            ),
          ),
        list: (prefix) =>
          safePath(root, prefix.length === 0 ? "." : prefix).pipe(
            Effect.flatMap(() =>
              fileSystem.exists(root).pipe(
                Effect.mapError((cause) => storageFailure("inspect object store", cause)),
                Effect.flatMap((exists) =>
                  exists
                    ? fileSystem.readDirectory(root, { recursive: true }).pipe(
                        Effect.mapError((cause) => storageFailure("list objects", cause)),
                        Effect.flatMap((entries) =>
                          Effect.filter(
                            entries,
                            (entry) =>
                              fileSystem.stat(path.join(root, entry)).pipe(
                                Effect.mapError((cause) => storageFailure("inspect object", cause)),
                                Effect.map((info) => info.type === "File"),
                              ),
                            { concurrency: 16 },
                          ),
                        ),
                        Effect.map((entries) =>
                          entries
                            .map((entry) => entry.split(path.sep).join("/"))
                            .filter((entry) => entry.startsWith(prefix) && !entry.includes(".tmp-"))
                            .toSorted(),
                        ),
                      )
                    : Effect.succeed([]),
                ),
              ),
            ),
          ),
        put: (key, bytes, options) =>
          Effect.gen(function* () {
            const filePath = yield* safePath(root, key);
            const sidecarPath = yield* metadataPath(key);
            const actualDigest = yield* digest.sha256(bytes);
            if (actualDigest !== options.digest) {
              return yield* Effect.fail(
                new StorageError({
                  message: "The supplied object digest does not match its bytes.",
                  operation: "put object",
                  retryable: false,
                }),
              );
            }
            yield* atomicWrite(fileSystem, filePath, bytes);
            yield* atomicWrite(
              fileSystem,
              sidecarPath,
              textEncoder.encode(
                JSON.stringify({ digest: options.digest, mediaType: options.mediaType }),
              ),
            );
          }),
      };
      return service;
    }),
  );
}

export function journalLayer(
  dataDirectory: string,
): Layer.Layer<DurableDocumentJournalService, never, FileSystem.FileSystem | DigestService> {
  return Layer.effect(
    DurableDocumentJournal,
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const digest = yield* Digest;
      const mutex = yield* Effect.makeSemaphore(1);
      const cache = new Map<string, readonly JournalEntry[]>();
      const root = path.join(dataDirectory, "journals");

      const load = (document: string): Effect.Effect<readonly JournalEntry[], StorageError> =>
        Effect.suspend(() => {
          const cached = cache.get(document);
          if (cached !== undefined) {
            return Effect.succeed(cached);
          }
          const filePath = path.join(root, `${document}.jsonl`);
          return fileSystem.exists(filePath).pipe(
            Effect.mapError((cause) => storageFailure("inspect journal", cause)),
            Effect.flatMap((exists) =>
              exists
                ? fileSystem.readFileString(filePath).pipe(
                    Effect.mapError((cause) => storageFailure("read journal", cause)),
                    Effect.flatMap((contents) => decodeJournal(contents, document, digest)),
                  )
                : Effect.succeed([]),
            ),
            Effect.tap((entries) => Effect.sync(() => cache.set(document, entries))),
          );
        });

      const service: DurableDocumentJournalService = {
        append: (input) =>
          mutex.withPermits(1)(
            Effect.gen(function* () {
              const entries = yield* load(input.documentId);
              if (input.idempotencyKey !== undefined) {
                const existing = entries.find(
                  (entry) => entry.idempotencyKey === input.idempotencyKey,
                );
                if (existing !== undefined) {
                  return existing;
                }
              }
              const latestSequence = entries.at(-1)?.sequence;
              if (latestSequence !== undefined && latestSequence !== input.previousSequence) {
                return yield* Effect.fail(
                  new StorageError({
                    message: "The journal sequence does not match the document authority.",
                    operation: "append journal",
                    retryable: false,
                  }),
                );
              }
              const sequence = input.previousSequence + 1;
              const recordWithoutChecksum = {
                documentId: input.documentId,
                ...(input.idempotencyKey === undefined
                  ? {}
                  : { idempotencyKey: input.idempotencyKey }),
                kind: input.kind,
                payload: encodeBase64(input.payload),
                revision: input.revision,
                sequence,
              };
              const checksum = yield* digest.sha256(
                textEncoder.encode(JSON.stringify(recordWithoutChecksum)),
              );
              const record: JournalRecord = { ...recordWithoutChecksum, checksum };
              const filePath = path.join(root, `${input.documentId}.jsonl`);
              yield* fileSystem
                .makeDirectory(root, { recursive: true })
                .pipe(
                  Effect.mapError((cause) => storageFailure("create journal directory", cause)),
                );
              yield* Effect.scoped(
                fileSystem.open(filePath, { flag: "a" }).pipe(
                  Effect.mapError((cause) => storageFailure("open journal", cause)),
                  Effect.flatMap((file) =>
                    file.writeAll(textEncoder.encode(`${JSON.stringify(record)}\n`)).pipe(
                      Effect.mapError((cause) => storageFailure("append journal", cause)),
                      Effect.zipRight(
                        file.sync.pipe(
                          Effect.mapError((cause) => storageFailure("sync journal", cause)),
                        ),
                      ),
                    ),
                  ),
                ),
              );
              const entry: JournalEntry = { ...input, sequence };
              cache.set(input.documentId, [...entries, entry]);
              return entry;
            }),
          ),
        entriesAfter: (documentId, sequence) =>
          mutex.withPermits(1)(
            load(documentId).pipe(
              Effect.map((entries) => entries.filter((entry) => entry.sequence > sequence)),
            ),
          ),
        truncateThrough: (documentId, sequence) =>
          mutex.withPermits(1)(
            Effect.gen(function* () {
              const entries = yield* load(documentId);
              const retained = entries.filter((entry) => entry.sequence > sequence);
              const records: string[] = [];
              for (const entry of retained) {
                const withoutChecksum = {
                  documentId: entry.documentId,
                  ...(entry.idempotencyKey === undefined
                    ? {}
                    : { idempotencyKey: entry.idempotencyKey }),
                  kind: entry.kind,
                  payload: encodeBase64(entry.payload),
                  revision: entry.revision,
                  sequence: entry.sequence,
                };
                records.push(
                  JSON.stringify({
                    ...withoutChecksum,
                    checksum: yield* digest.sha256(
                      textEncoder.encode(JSON.stringify(withoutChecksum)),
                    ),
                  }),
                );
              }
              const filePath = path.join(root, `${documentId}.jsonl`);
              yield* atomicWrite(
                fileSystem,
                filePath,
                textEncoder.encode(records.length === 0 ? "" : `${records.join("\n")}\n`),
              );
              cache.set(documentId, retained);
            }),
          ),
      };
      return service;
    }),
  );
}

export function workspaceStateStoreLayer(
  dataDirectory: string,
): Layer.Layer<WorkspaceStateStoreService, never, FileSystem.FileSystem> {
  return Layer.effect(
    WorkspaceStateStore,
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const filePath = path.join(dataDirectory, "workspace.json");
      const service: WorkspaceStateStoreService = {
        load: <A>() =>
          fileSystem.exists(filePath).pipe(
            Effect.mapError((cause) => storageFailure("inspect workspace state", cause)),
            Effect.flatMap((exists) =>
              exists
                ? fileSystem.readFileString(filePath).pipe(
                    Effect.mapError((cause) => storageFailure("read workspace state", cause)),
                    Effect.flatMap((value) =>
                      Effect.try({
                        catch: (cause) => storageFailure("decode workspace state", cause),
                        try: () => JSON.parse(value) as A,
                      }),
                    ),
                  )
                : Effect.succeed(undefined),
            ),
          ),
        save: <A>(state: A) =>
          atomicWrite(fileSystem, filePath, textEncoder.encode(JSON.stringify(state))),
      };
      return service;
    }),
  );
}

function decodeJournal(
  contents: string,
  expectedDocument: string,
  digest: DigestService,
): Effect.Effect<readonly JournalEntry[], StorageError> {
  return Effect.gen(function* () {
    const complete = contents.endsWith("\n")
      ? contents
      : contents.slice(0, contents.lastIndexOf("\n") + 1);
    const lines = complete.split("\n").filter(Boolean);
    const entries: JournalEntry[] = [];
    for (const line of lines) {
      const record = yield* Schema.decodeUnknown(Schema.parseJson(journalRecordSchema))(line).pipe(
        Effect.mapError((cause) => storageFailure("decode journal record", cause)),
      );
      const { checksum, ...withoutChecksum } = record;
      const actualChecksum = yield* digest.sha256(
        textEncoder.encode(JSON.stringify(withoutChecksum)),
      );
      if (checksum !== actualChecksum || record.documentId !== expectedDocument) {
        return yield* Effect.fail(
          new StorageError({
            message: "A durable journal record failed its integrity check.",
            operation: "read journal",
            retryable: false,
          }),
        );
      }
      const payload = yield* decodeBase64(record.payload).pipe(
        Effect.mapError((cause) => storageFailure("decode journal payload", cause)),
      );
      entries.push({
        documentId: record.documentId as JournalEntry["documentId"],
        idempotencyKey: record.idempotencyKey,
        kind: record.kind,
        payload,
        previousSequence: record.sequence - 1,
        revision: record.revision as JournalEntry["revision"],
        sequence: record.sequence,
      });
    }
    return entries;
  });
}

function readObjectMetadata(
  fileSystem: FileSystem.FileSystem,
  filePath: string,
): Effect.Effect<typeof objectMetadataSchema.Type | undefined, StorageError> {
  return fileSystem.exists(filePath).pipe(
    Effect.mapError((cause) => storageFailure("inspect object metadata", cause)),
    Effect.flatMap((exists) =>
      exists
        ? fileSystem.readFile(filePath).pipe(
            Effect.mapError((cause) => storageFailure("read object metadata", cause)),
            Effect.flatMap((bytes) =>
              Schema.decodeUnknown(Schema.parseJson(objectMetadataSchema))(
                textDecoder.decode(bytes),
              ).pipe(Effect.mapError((cause) => storageFailure("decode object metadata", cause))),
            ),
          )
        : Effect.succeed(undefined),
    ),
  );
}

function atomicWrite(
  fileSystem: FileSystem.FileSystem,
  filePath: string,
  bytes: Uint8Array,
): Effect.Effect<void, StorageError> {
  return Effect.gen(function* () {
    yield* fileSystem
      .makeDirectory(path.dirname(filePath), { recursive: true })
      .pipe(Effect.mapError((cause) => storageFailure("create storage directory", cause)));
    const temporary = `${filePath}.tmp-${taggedId(
      identifierTag.temporaryFile,
      uuidV7Bytes(Date.now(), crypto.getRandomValues(new Uint8Array(10))),
    )}`;
    yield* Effect.scoped(
      fileSystem.open(temporary, { flag: "wx" }).pipe(
        Effect.mapError((cause) => storageFailure("open temporary file", cause)),
        Effect.flatMap((file) =>
          (bytes.byteLength === 0 ? Effect.void : file.writeAll(bytes)).pipe(
            Effect.mapError((cause) => storageFailure("write temporary file", cause)),
            Effect.zipRight(
              file.sync.pipe(
                Effect.mapError((cause) => storageFailure("sync temporary file", cause)),
              ),
            ),
          ),
        ),
      ),
    );
    yield* fileSystem
      .rename(temporary, filePath)
      .pipe(Effect.mapError((cause) => storageFailure("commit atomic file", cause)));
  });
}

function safePath(root: string, key: string): Effect.Effect<string, StorageError> {
  const normalized = key.split("/").join(path.sep);
  const resolved = path.resolve(root, normalized);
  const relative = path.relative(root, resolved);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
    ? Effect.succeed(resolved)
    : Effect.fail(
        new StorageError({
          message: "Object keys may not escape the object-store root.",
          operation: "validate object key",
          retryable: false,
        }),
      );
}

function mediaTypeForKey(key: string): string | undefined {
  if (key.endsWith(".json")) return "application/json";
  if (key.endsWith(".md")) return "text/markdown; charset=utf-8";
  if (key.endsWith(".html")) return "text/html; charset=utf-8";
  return undefined;
}

function storageFailure(operation: string, cause: unknown): StorageError {
  return new StorageError({
    cause,
    message: `Local storage failed while attempting to ${operation}.`,
    operation,
    retryable: true,
  });
}
