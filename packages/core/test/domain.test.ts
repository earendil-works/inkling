import assert from "node:assert/strict";
import test from "node:test";

import { Effect, Either } from "effect";

import {
  activateDocument,
  allocateRfcNumber,
  applyUniqueTextReplacements,
  assignRfcNumber,
  authorizeDocument,
  createCommentThread,
  createDocumentMetadata,
  createWorkspaceSession,
  authenticateSession,
  documentId,
  documentTitleFromMarkdown,
  emptyCommentState,
  encodeBase62,
  IdGenerator,
  normalizeSearchText,
  parseCatalogSearchQuery,
  personId,
  reserveDocument,
  searchCatalog,
  SecretHasher,
  SecureToken,
  emptyAuthenticationState,
  emptyWorkspaceCatalog,
  hasPendingPublicationChanges,
  taggedId,
  updateDocumentMetadata,
  updateSharingPolicy,
} from "../src/index.ts";
import type {
  CatalogSummary,
  CommentActor,
  DocumentMetadata,
  Principal,
  WorkspaceCatalogState,
} from "../src/index.ts";

const now = "2026-01-02T03:04:05.000Z";

function catalogSummary(metadata: DocumentMetadata, body: string): CatalogSummary {
  return {
    approvers: metadata.approvers,
    authors: metadata.authors,
    documentId: metadata.id,
    excerpt: normalizeSearchText(body).slice(0, 240),
    labels: metadata.labels,
    metadata,
    normalizedBody: normalizeSearchText(body),
    publishedRevision: metadata.publishedRevision,
    revision: metadata.headRevision,
    reviewers: metadata.reviewers,
    rfcNumber: metadata.rfcNumber,
    sensitivity: metadata.sensitivity,
    state: metadata.lifecycleState,
    title: metadata.title,
    updatedAt: metadata.updatedAt,
    visibility: metadata.visibility,
  };
}

test("identifiers use the canonical base62 alphabet", () => {
  assert.equal(encodeBase62(Uint8Array.of(0)), "0");
  assert.equal(encodeBase62(Uint8Array.of(61)), "Z");
  assert.equal(encodeBase62(Uint8Array.of(62)), "10");
  assert.equal(taggedId("doc", Uint8Array.of(62)), "doc_10");
});

test("metadata revisions reject stale commands and confidential public transitions", async () => {
  const metadata = await Effect.runPromise(
    createDocumentMetadata({ id: "document_123456789", title: "Decision" }, now),
  );
  const updated = await Effect.runPromise(
    updateDocumentMetadata(metadata, { lifecycleState: "custom imported state" }, 0, now),
  );
  assert.equal(updated.headRevision, 1);
  assert.equal(updated.lifecycleState, "custom imported state");

  const stale = await Effect.runPromise(
    updateDocumentMetadata(updated, { lifecycleState: "stale" }, 0, now).pipe(Effect.either),
  );
  assert.equal(Either.isLeft(stale) && stale.left.code, "revision_conflict");

  const confidential = await Effect.runPromise(
    updateDocumentMetadata(updated, { sensitivity: "confidential" }, 1, now),
  );
  const unsafePublic = await Effect.runPromise(
    updateDocumentMetadata(confidential, { visibility: "public" }, 2, now).pipe(Effect.either),
  );
  assert.equal(
    Either.isLeft(unsafePublic) && unsafePublic.left.code,
    "confidential_public_confirmation_required",
  );
});

test("document titles come from the first top-level Markdown heading", () => {
  assert.equal(
    documentTitleFromMarkdown(
      "---\nstate: draft\n---\n\n```md\n# Not the title\n```\n\n# **Actual** [title](https://example.com)\n",
    ),
    "Actual title",
  );
  assert.equal(documentTitleFromMarkdown("Setext title\n===\n\nBody"), "Setext title");
  assert.equal(documentTitleFromMarkdown("## Section only"), undefined);
});

test("workspace identity sessions retain their verified principal", async () => {
  const id = await Effect.runPromise(personId("writer@example.com"));
  const hasher = {
    hash: (secret: string) => Effect.succeed(`hashed:${secret}`),
    verify: (secret: string, hash: string) => Effect.succeed(hash === `hashed:${secret}`),
  };
  const ids = { generate: (purpose: string) => Effect.succeed(`${purpose}_12345678`) };
  const tokens = { generate: () => Effect.succeed("session-secret") };
  const created = await Effect.runPromise(
    createWorkspaceSession(
      emptyAuthenticationState(),
      {
        displayName: "Example Writer",
        email: "writer@example.com",
        personId: id,
        role: "member",
      },
      now,
    ).pipe(
      Effect.provideService(IdGenerator, ids),
      Effect.provideService(SecretHasher, hasher),
      Effect.provideService(SecureToken, tokens),
    ),
  );
  const principal = await Effect.runPromise(
    authenticateSession(created.state, created.token, now).pipe(
      Effect.provideService(SecretHasher, hasher),
    ),
  );
  assert.deepEqual(principal, {
    displayName: "Example Writer",
    kind: "workspace",
    personId: id,
    role: "member",
  });
});

test("capability generations revoke existing principals", async () => {
  const metadata = await Effect.runPromise(
    createDocumentMetadata({ id: "document_123456789", title: "Decision" }, now),
  );
  const shared = await Effect.runPromise(updateSharingPolicy(metadata, "edit", 0, now));
  const principal: Principal = {
    access: "edit",
    documentId: metadata.id,
    generation: shared.sharing.generation,
    kind: "capability",
  };
  await Effect.runPromise(authorizeDocument(principal, "edit-body", shared, now));

  const revoked = await Effect.runPromise(updateSharingPolicy(shared, "disabled", 1, now));
  const denied = await Effect.runPromise(
    authorizeDocument(principal, "edit-body", revoked, now).pipe(Effect.either),
  );
  assert.equal(Either.isLeft(denied), true);
});

test("agent replacements are atomic and reject ambiguity", async () => {
  const changed = await Effect.runPromise(
    applyUniqueTextReplacements("alpha beta gamma", [
      { newText: "A", oldText: "alpha" },
      { newText: "G", oldText: "gamma" },
    ]),
  );
  assert.equal(changed, "A beta G");

  const ambiguous = await Effect.runPromise(
    applyUniqueTextReplacements("same and same", [{ newText: "new", oldText: "same" }]).pipe(
      Effect.either,
    ),
  );
  assert.equal(Either.isLeft(ambiguous) && ambiguous.left.code, "ambiguous_text");
});

test("RFC reservations are idempotent and numbers are never reused", async () => {
  const first = await Effect.runPromise(
    reserveDocument(emptyWorkspaceCatalog(), {
      allocateRfc: true,
      creationKey: "request-1",
      documentId: "document_123456789",
    }),
  );
  assert.equal(first.entry.rfcNumber, 1);
  const retried = await Effect.runPromise(
    reserveDocument(first.state, {
      allocateRfc: true,
      creationKey: "request-1",
      documentId: "different_123456789",
    }),
  );
  assert.equal(retried.entry.documentId, first.entry.documentId);
  assert.equal(retried.state.nextRfcNumber, 2);

  const unnumbered = await Effect.runPromise(
    reserveDocument(retried.state, {
      allocateRfc: false,
      creationKey: "request-2",
      documentId: "document_987654321",
    }),
  );
  const active = await Effect.runPromise(
    activateDocument(unnumbered.state, unnumbered.entry.documentId),
  );
  const allocated = await Effect.runPromise(allocateRfcNumber(active, unnumbered.entry.documentId));
  assert.equal(allocated.rfcNumber, 2);
  const allocatedAgain = await Effect.runPromise(
    allocateRfcNumber(allocated.state, unnumbered.entry.documentId),
  );
  assert.equal(allocatedAgain.rfcNumber, 2);
  assert.equal(allocatedAgain.state.nextRfcNumber, 3);

  const metadata = await Effect.runPromise(
    createDocumentMetadata({ id: unnumbered.entry.documentId, title: "Later RFC" }, now),
  );
  const numbered = await Effect.runPromise(assignRfcNumber(metadata, allocated.rfcNumber, now));
  assert.equal(numbered.rfcNumber, 2);
  assert.equal(numbered.headRevision, 1);
  assert.equal(await Effect.runPromise(assignRfcNumber(numbered, 2, now)), numbered);
});

test("catalog search covers full bodies and Gmail-style metadata filters", async () => {
  const authorId = await Effect.runPromise(personId("armin@example.com"));
  const author = {
    displayName: "A. Ronacher",
    email: "armin@example.com",
    id: authorId,
  };
  const rfcMetadata = await Effect.runPromise(
    createDocumentMetadata(
      {
        authors: [author],
        id: "document_search_rfc",
        labels: ["machine-learning", "platform"],
        rfcNumber: 42,
        title: "Durable Search",
      },
      now,
    ),
  );
  const noteMetadata = await Effect.runPromise(
    createDocumentMetadata(
      {
        id: "document_search_note",
        labels: ["platform"],
        sensitivity: "confidential",
        title: "Private planning notes",
      },
      now,
    ),
  );
  const deepBody = `${"ordinary introduction ".repeat(30)}durable checkpoint recovery details`;
  const state: WorkspaceCatalogState = {
    entries: [
      {
        creationKey: "search-rfc",
        documentId: rfcMetadata.id,
        rfcNumber: rfcMetadata.rfcNumber,
        status: "active",
        summary: catalogSummary(rfcMetadata, deepBody),
      },
      {
        creationKey: "search-note",
        documentId: noteMetadata.id,
        status: "active",
        summary: {
          ...catalogSummary(noteMetadata, "confidential budget planning"),
          workingLabels: ["planning"],
        },
      },
    ],
    nextRfcNumber: 43,
    people: [{ aliases: ["mitsuhiko"], person: author }],
  };

  assert.deepEqual(parseCatalogSearchQuery('label:"machine learning" -state:abandoned'), {
    terms: [
      { field: "label", negated: false, value: "machine learning" },
      { field: "state", negated: true, value: "abandoned" },
    ],
  });
  const fullText = searchCatalog(state, '"durable checkpoint"');
  assert.equal(fullText[0]?.documentId, rfcMetadata.id);
  assert.match(fullText[0]?.excerpt ?? "", /durable checkpoint/u);
  assert.equal(
    searchCatalog(state, "label:platform -is:confidential")[0]?.documentId,
    rfcMetadata.id,
  );
  assert.equal(searchCatalog(state, "author:mitsuhiko")[0]?.documentId, rfcMetadata.id);
  assert.equal(searchCatalog(state, "rfc:0042")[0]?.documentId, rfcMetadata.id);
  assert.equal(searchCatalog(state, "label:planning")[0]?.documentId, noteMetadata.id);
  assert.equal(searchCatalog(state, "is:note")[0]?.documentId, noteMetadata.id);
});

test("publication changes exclude the publication bookkeeping revision", () => {
  assert.equal(hasPendingPublicationChanges({ headRevision: 0 }), true);
  assert.equal(hasPendingPublicationChanges({ headRevision: 5, publishedRevision: 4 }), false);
  assert.equal(hasPendingPublicationChanges({ headRevision: 6, publishedRevision: 4 }), true);
});

test("comment authors may edit their messages while stable anchors remain structured", async () => {
  const authorId = await Effect.runPromise(personId("person@example.com"));
  const actor: CommentActor = { displayName: "Person", id: authorId, manageAll: false };
  const comments = await Effect.runPromise(
    createCommentThread(
      emptyCommentState(),
      {
        anchor: {
          end: "relative-end",
          orphaned: false,
          originalEnd: 5,
          originalStart: 0,
          prefix: "",
          quote: "hello",
          start: "relative-start",
          suffix: " world",
        },
        body: "Please clarify.",
        id: "thread_12345678",
        messageId: "message_12345678",
      },
      actor,
      now,
    ),
  );
  assert.equal(comments.threads[0]?.messages[0]?.authorId, authorId);
  assert.equal(await Effect.runPromise(documentId("document_123456789")), "document_123456789");
});
