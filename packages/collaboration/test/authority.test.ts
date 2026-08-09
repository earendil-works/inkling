import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { Effect, Either } from "effect";

import {
  createDocumentMetadata,
  Digest,
  documentId,
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
  makeDocumentAuthority,
} from "../src/index.ts";

const now = "2026-01-02T03:04:05.000Z";

interface MemoryStorage {
  readonly objects: Map<string, StoredObject>;
  readonly entries: JournalEntry[];
  failAppend: boolean;
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
        Effect.sync(() => {
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
