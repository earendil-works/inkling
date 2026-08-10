import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { Effect, Either } from "effect";

import {
  createDocumentMetadata,
  Digest,
  documentId,
  documentRevision,
  DurableDocumentJournal,
  ObjectStore,
  personId,
  StorageError,
} from "@earendil-works/inkling-core";
import type {
  DigestService,
  DurableDocumentJournalService,
  JournalEntry,
  ObjectStoreService,
  Principal,
  StoredObject,
} from "@earendil-works/inkling-core";

import {
  applyDocumentUpdate,
  createCollaborativeDocument,
  encodeMissingState,
  listDocumentHistoryEvents,
  loadDocumentHistoryRevision,
  makeDocumentAuthority,
} from "../src/index.ts";

const now = "2026-01-02T03:04:05.000Z";

interface MemoryStorage {
  readonly objects: Map<string, StoredObject>;
  readonly entries: JournalEntry[];
  failAppend: boolean;
  failHistoryPut: boolean;
  failTruncate: boolean;
}

function memoryStorage(): {
  readonly state: MemoryStorage;
  readonly objects: ObjectStoreService;
  readonly journal: DurableDocumentJournalService;
  readonly digest: DigestService;
} {
  const state: MemoryStorage = {
    entries: [],
    failAppend: false,
    failHistoryPut: false,
    failTruncate: false,
    objects: new Map(),
  };
  const digest: DigestService = {
    sha256: (bytes) => Effect.succeed(createHash("sha256").update(bytes).digest("hex")),
  };
  return {
    digest,
    journal: {
      append: (input) => {
        if (state.failAppend) {
          return Effect.fail(
            new StorageError({
              message: "Injected append failure",
              operation: "append",
              retryable: true,
            }),
          );
        }
        const existing = state.entries.find(
          (entry) =>
            input.idempotencyKey !== undefined &&
            entry.idempotencyKey === input.idempotencyKey &&
            entry.documentId === input.documentId,
        );
        if (existing !== undefined) return Effect.succeed(existing);
        const entry: JournalEntry = { ...input, sequence: input.previousSequence + 1 };
        state.entries.push(entry);
        return Effect.succeed(entry);
      },
      entriesAfter: (id, sequence) =>
        Effect.succeed(
          state.entries.filter((entry) => entry.documentId === id && entry.sequence > sequence),
        ),
      delete: (id) =>
        Effect.sync(() => {
          const retained = state.entries.filter((entry) => entry.documentId !== id);
          state.entries.splice(0, state.entries.length, ...retained);
        }),
      truncateThrough: (id, sequence) => {
        if (state.failTruncate) {
          return Effect.fail(
            new StorageError({
              message: "Injected truncate failure",
              operation: "truncate",
              retryable: true,
            }),
          );
        }
        const retained = state.entries.filter(
          (entry) => entry.documentId !== id || entry.sequence > sequence,
        );
        state.entries.splice(0, state.entries.length, ...retained);
        return Effect.void;
      },
    },
    objects: {
      delete: (key) => Effect.sync(() => void state.objects.delete(key)),
      get: (key) => Effect.succeed(state.objects.get(key)),
      list: (prefix) =>
        Effect.succeed([...state.objects.keys()].filter((key) => key.startsWith(prefix))),
      put: (key, bytes, options) =>
        state.failHistoryPut && key.includes("/history/")
          ? Effect.fail(
              new StorageError({
                message: "Injected history write failure",
                operation: "write history",
                retryable: true,
              }),
            )
          : Effect.sync(() => {
              state.objects.set(key, { bytes: new Uint8Array(bytes), digest: options.digest });
            }),
    },
    state,
  };
}

async function fixture() {
  const storage = memoryStorage();
  const id = await Effect.runPromise(documentId("document_123456789"));
  const administratorId = await Effect.runPromise(personId("admin@example.com"));
  const metadata = await Effect.runPromise(
    createDocumentMetadata({ id, title: "Durability" }, now),
  );
  const principal: Principal = {
    kind: "workspace",
    personId: administratorId,
    role: "administrator",
  };
  const make = (initial = true) =>
    Effect.runPromise(
      makeDocumentAuthority({
        documentId: id,
        ...(initial ? { initialBody: "hello", initialMetadata: metadata } : {}),
        workspaceId: "test",
      }).pipe(
        Effect.provideService(ObjectStore, storage.objects),
        Effect.provideService(DurableDocumentJournal, storage.journal),
        Effect.provideService(Digest, storage.digest),
      ),
    );
  return { id, make, metadata, principal, storage };
}

test("an update is not applied when its durable append fails", async () => {
  const fixtureValue = await fixture();
  const authority = await fixtureValue.make();
  const before = await Effect.runPromise(authority.snapshot(fixtureValue.principal, now));
  const client = await Effect.runPromise(createCollaborativeDocument());
  await Effect.runPromise(applyDocumentUpdate(client.document, before.stateUpdate));
  client.body.insert(client.body.length, " world");
  const update = await Effect.runPromise(encodeMissingState(client.document, before.stateVector));

  fixtureValue.storage.state.failAppend = true;
  const result = await Effect.runPromise(
    authority
      .acceptBodyUpdate(fixtureValue.principal, update, "client-update-1", now)
      .pipe(Effect.either),
  );
  assert.equal(Either.isLeft(result), true);
  const after = await Effect.runPromise(authority.snapshot(fixtureValue.principal, now));
  assert.equal(after.body, "hello");
});

test("accepted body updates derive the document title from the top-level heading", async () => {
  const fixtureValue = await fixture();
  const authority = await fixtureValue.make();
  const before = await Effect.runPromise(authority.snapshot(fixtureValue.principal, now));
  const client = await Effect.runPromise(createCollaborativeDocument());
  await Effect.runPromise(applyDocumentUpdate(client.document, before.stateUpdate));
  client.body.delete(0, client.body.length);
  client.body.insert(0, "# Derived title\n\nBody");
  const update = await Effect.runPromise(encodeMissingState(client.document, before.stateVector));

  await Effect.runPromise(
    authority.acceptBodyUpdate(fixtureValue.principal, update, "title-update", now),
  );
  const after = await Effect.runPromise(authority.snapshot(fixtureValue.principal, now));
  assert.equal(after.metadata.title, "Derived title");
});

test("deleted authorities remain editable and can be restored by administrators", async () => {
  const fixtureValue = await fixture();
  const authority = await fixtureValue.make();
  const deleted = await Effect.runPromise(
    authority.deleteDocument(fixtureValue.principal, fixtureValue.metadata.headRevision, now),
  );
  assert.equal(deleted.deletedAt, now);
  const trashed = await Effect.runPromise(authority.snapshot(fixtureValue.principal, now));
  assert.equal(trashed.metadata.deletedAt, now);
  await Effect.runPromise(
    authority.applyTextEdits(
      fixtureValue.principal,
      [{ newText: "hello from Trash", oldText: "hello" }],
      deleted.headRevision,
      now,
    ),
  );
  const edited = await Effect.runPromise(authority.snapshot(fixtureValue.principal, now));
  assert.equal(edited.body, "hello from Trash");
  const restored = await Effect.runPromise(
    authority.restoreDocument(fixtureValue.principal, edited.metadata.headRevision, now),
  );
  assert.equal(restored.deletedAt, undefined);
  assert.equal(restored.headRevision, edited.metadata.headRevision + 1);
});

test("checkpoint plus durable tail recovers every acknowledged update", async () => {
  const fixtureValue = await fixture();
  const authority = await fixtureValue.make();
  const first = await Effect.runPromise(authority.snapshot(fixtureValue.principal, now));
  const client = await Effect.runPromise(createCollaborativeDocument());
  await Effect.runPromise(applyDocumentUpdate(client.document, first.stateUpdate));
  client.body.insert(client.body.length, " durable");
  const firstUpdate = await Effect.runPromise(
    encodeMissingState(client.document, first.stateVector),
  );
  await Effect.runPromise(
    authority.acceptBodyUpdate(fixtureValue.principal, firstUpdate, "update-1", now),
  );
  await Effect.runPromise(authority.checkpoint(now));

  const checkpointed = await Effect.runPromise(authority.snapshot(fixtureValue.principal, now));
  client.body.insert(client.body.length, " tail");
  const tail = await Effect.runPromise(
    encodeMissingState(client.document, checkpointed.stateVector),
  );
  await Effect.runPromise(
    authority.acceptBodyUpdate(fixtureValue.principal, tail, "update-2", now),
  );

  const recovered = await fixtureValue.make(false);
  const snapshot = await Effect.runPromise(recovered.snapshot(fixtureValue.principal, now));
  assert.equal(snapshot.body, "hello durable tail");
});

test("compressed update segments reconstruct every archived document revision", async () => {
  const fixtureValue = await fixture();
  const authority = await fixtureValue.make();
  await Effect.runPromise(authority.checkpoint(now));

  await Effect.runPromise(
    authority.applyTextEdits(
      fixtureValue.principal,
      [{ newText: "hello one", oldText: "hello" }],
      fixtureValue.metadata.headRevision,
      "2026-01-02T03:05:00.000Z",
    ),
  );
  await Effect.runPromise(authority.checkpoint("2026-01-02T03:05:01.000Z"));
  await Effect.runPromise(
    authority.applyTextEdits(
      fixtureValue.principal,
      [{ newText: "hello two", oldText: "hello one" }],
      await Effect.runPromise(documentRevision(1)),
      "2026-01-02T03:06:00.000Z",
    ),
  );
  await Effect.runPromise(authority.checkpoint("2026-01-02T03:06:01.000Z"));

  const historyEffect = <A, E>(
    effect: Effect.Effect<A, E, typeof ObjectStore.Service | typeof Digest.Service>,
  ) =>
    Effect.runPromise(
      effect.pipe(
        Effect.provideService(ObjectStore, fixtureValue.storage.objects),
        Effect.provideService(Digest, fixtureValue.storage.digest),
      ),
    );
  const events = await historyEffect(
    listDocumentHistoryEvents({ documentId: fixtureValue.id, workspaceId: "test" }),
  );
  assert.deepEqual(
    events.map((event) => ({
      actor: event.actor?.id,
      occurredAt: event.occurredAt,
      revision: event.revision,
      source: event.source,
    })),
    [
      {
        actor: "admin@example.com",
        occurredAt: "2026-01-02T03:05:00.000Z",
        revision: 1,
        source: "command",
      },
      {
        actor: "admin@example.com",
        occurredAt: "2026-01-02T03:06:00.000Z",
        revision: 2,
        source: "command",
      },
    ],
  );
  const first = await historyEffect(
    loadDocumentHistoryRevision(
      { documentId: fixtureValue.id, workspaceId: "test" },
      await Effect.runPromise(documentRevision(1)),
    ),
  );
  const second = await historyEffect(
    loadDocumentHistoryRevision(
      { documentId: fixtureValue.id, workspaceId: "test" },
      await Effect.runPromise(documentRevision(2)),
    ),
  );
  assert.equal(first.body, "hello one");
  assert.equal(second.body, "hello two");

  const historyObjects = [...fixtureValue.storage.state.objects.entries()].filter(([key]) =>
    key.includes("/history/"),
  );
  assert.equal(historyObjects.filter(([key]) => key.includes("/checkpoints/")).length, 1);
  assert.equal(historyObjects.filter(([key]) => key.includes("/segments/")).length, 2);
  for (const [, stored] of historyObjects) {
    assert.deepEqual(Array.from(stored.bytes.slice(0, 2)), [0x1f, 0x8b]);
  }
});

test("long update logs gain periodic history snapshots", async () => {
  const fixtureValue = await fixture();
  const authority = await fixtureValue.make();
  await Effect.runPromise(authority.checkpoint(now));
  await Effect.runPromise(
    Effect.forEach(
      Array.from({ length: 100 }, (_, revision) => revision),
      (revision) =>
        documentRevision(revision).pipe(
          Effect.flatMap((expectedRevision) =>
            authority.applyTextEdits(
              fixtureValue.principal,
              [
                {
                  newText: `hello${"x".repeat(revision + 1)}`,
                  oldText: `hello${"x".repeat(revision)}`,
                },
              ],
              expectedRevision,
              new Date(Date.parse(now) + revision * 1_000).toISOString(),
            ),
          ),
        ),
      { discard: true },
    ),
  );
  await Effect.runPromise(authority.checkpoint("2026-01-02T05:00:00.000Z"));

  const checkpointKeys = [...fixtureValue.storage.state.objects.keys()].filter((key) =>
    key.includes("/history/checkpoints/"),
  );
  assert.equal(checkpointKeys.length, 2);
  const middle = await Effect.runPromise(
    loadDocumentHistoryRevision(
      { documentId: fixtureValue.id, workspaceId: "test" },
      await Effect.runPromise(documentRevision(50)),
    ).pipe(
      Effect.provideService(ObjectStore, fixtureValue.storage.objects),
      Effect.provideService(Digest, fixtureValue.storage.digest),
    ),
  );
  assert.equal(middle.body, `hello${"x".repeat(50)}`);
});

test("history archival succeeds before the hot journal is truncated", async () => {
  const fixtureValue = await fixture();
  const authority = await fixtureValue.make();
  await Effect.runPromise(authority.checkpoint(now));
  await Effect.runPromise(
    authority.applyTextEdits(
      fixtureValue.principal,
      [{ newText: "retained edit", oldText: "hello" }],
      fixtureValue.metadata.headRevision,
      "2026-01-02T03:05:00.000Z",
    ),
  );

  fixtureValue.storage.state.failHistoryPut = true;
  const checkpoint = await Effect.runPromise(authority.checkpoint(now).pipe(Effect.either));
  assert.equal(Either.isLeft(checkpoint), true);
  assert.equal(fixtureValue.storage.state.entries.length, 1);
});

test("recovery tolerates checkpoint success followed by journal truncation failure", async () => {
  const fixtureValue = await fixture();
  const authority = await fixtureValue.make();
  const snapshot = await Effect.runPromise(authority.snapshot(fixtureValue.principal, now));
  const client = await Effect.runPromise(createCollaborativeDocument());
  await Effect.runPromise(applyDocumentUpdate(client.document, snapshot.stateUpdate));
  client.body.insert(client.body.length, " once");
  const update = await Effect.runPromise(encodeMissingState(client.document, snapshot.stateVector));
  await Effect.runPromise(
    authority.acceptBodyUpdate(fixtureValue.principal, update, "deduplicated-update", now),
  );

  fixtureValue.storage.state.failTruncate = true;
  const checkpoint = await Effect.runPromise(authority.checkpoint(now).pipe(Effect.either));
  assert.equal(Either.isLeft(checkpoint), true);
  fixtureValue.storage.state.failTruncate = false;

  const recovered = await fixtureValue.make(false);
  const after = await Effect.runPromise(recovered.snapshot(fixtureValue.principal, now));
  assert.equal(after.body, "hello once");
});
