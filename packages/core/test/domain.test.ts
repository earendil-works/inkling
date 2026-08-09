import assert from "node:assert/strict";
import test from "node:test";

import { Effect, Either } from "effect";

import {
  activateDocument,
  allocateRfcNumber,
  apiKeyBelongsTo,
  applyCatalogSummary,
  applyUniqueTextReplacements,
  authenticateApiKey,
  assignRfcNumber,
  authorizeDocument,
  createApiKey,
  createCommentThread,
  createDocumentMetadata,
  createWorkspaceSession,
  authenticateSession,
  documentId,
  documentTitleFromMarkdown,
  emptyCommentState,
  encodeBase62,
  IdGenerator,
  markPublished,
  normalizeDocumentMetadata,
  normalizeSearchText,
  parseCatalogSearchQuery,
  personId,
  reserveDocument,
  resolveAuthorsByEmail,
  revokeApiKey,
  searchCatalog,
  SecretHasher,
  SecureToken,
  emptyAuthenticationState,
  emptyWorkspaceCatalog,
  hasPendingPublicationChanges,
  identifierTag,
  taggedId,
  updateDocumentMetadata,
  updateSharingPolicy,
  uuidV7Bytes,
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
    state: metadata.lifecycleState,
    title: metadata.title,
    updatedAt: metadata.updatedAt,
    visibility: metadata.visibility,
  };
}

test("identifiers use compact UUIDv7 tags and the canonical base62 alphabet", () => {
  assert.equal(encodeBase62(Uint8Array.of(0)), "0");
  assert.equal(encodeBase62(Uint8Array.of(61)), "Z");
  assert.equal(encodeBase62(Uint8Array.of(62)), "10");
  assert.equal(taggedId(identifierTag.document, Uint8Array.of(62)), "doc_10");
  const tags = Object.values(identifierTag);
  assert.equal(new Set(tags).size, tags.length);
  for (const tag of tags) {
    assert.match(tag, /^[a-z][a-z0-9]{1,2}$/u);
  }

  const bytes = uuidV7Bytes(
    0x0123_4567_89ab,
    Uint8Array.of(0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99),
  );
  assert.deepEqual(
    [...bytes],
    [
      0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0x70, 0x11, 0xa2, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88,
      0x99,
    ],
  );
});

test("metadata revisions reject stale commands and use one visibility field", async () => {
  const metadata = await Effect.runPromise(
    createDocumentMetadata({ id: "document_123456789", title: "Decision" }, now),
  );
  assert.equal(metadata.visibility, "private");

  const updated = await Effect.runPromise(
    updateDocumentMetadata(
      metadata,
      { lifecycleState: "custom imported state", visibility: "confidential" },
      0,
      now,
    ),
  );
  assert.equal(updated.headRevision, 1);
  assert.equal(updated.lifecycleState, "custom imported state");
  assert.equal(updated.visibility, "confidential");

  const stale = await Effect.runPromise(
    updateDocumentMetadata(updated, { lifecycleState: "stale" }, 0, now).pipe(Effect.either),
  );
  assert.equal(Either.isLeft(stale) && stale.left.code, "revision_conflict");

  const legacy = normalizeDocumentMetadata({
    ...updated,
    sensitivity: "confidential",
    visibility: "workspace",
  } as DocumentMetadata);
  assert.equal(legacy.visibility, "confidential");
  assert.equal("sensitivity" in legacy, false);
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

test("author email identifiers resolve known display names", async () => {
  const knownId = await Effect.runPromise(personId("ada@example.com"));
  const authors = await Effect.runPromise(
    resolveAuthorsByEmail(
      ["Ada@Example.com", "unknown@example.com", "ada@example.com"],
      [{ displayName: "Ada Lovelace", email: "ada@example.com", id: knownId }],
    ),
  );
  assert.deepEqual(authors, [
    { displayName: "Ada Lovelace", email: "ada@example.com", id: "ada@example.com" },
    {
      displayName: "unknown@example.com",
      email: "unknown@example.com",
      id: "unknown@example.com",
    },
  ]);
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

test("legacy credentials without a domain identity are rejected", async () => {
  const hasher = {
    hash: (secret: string) => Effect.succeed(`hashed:${secret}`),
    verify: (secret: string, hash: string) => Effect.succeed(hash === `hashed:${secret}`),
  };
  const state = {
    apiKeys: [
      {
        createdAt: now,
        id: "legacy-key",
        label: "Legacy key",
        tokenHash: "hashed:key-secret",
      },
    ],
    sessions: [
      {
        createdAt: now,
        expiresAt: "2099-01-01T00:00:00.000Z",
        id: "legacy-session",
        tokenHash: "hashed:session-secret",
      },
    ],
  };
  const session = await Effect.runPromise(
    authenticateSession(state, "legacy-session.session-secret", now).pipe(
      Effect.provideService(SecretHasher, hasher),
      Effect.either,
    ),
  );
  const apiKey = await Effect.runPromise(
    authenticateApiKey(state, "inkling_legacy-key.key-secret", now).pipe(
      Effect.provideService(SecretHasher, hasher),
      Effect.either,
    ),
  );
  assert.equal(Either.isLeft(session), true);
  assert.equal(Either.isLeft(apiKey), true);
});

test("API keys belong to their creator and retain that user's role", async () => {
  const accountId = await Effect.runPromise(personId("writer@example.com"));
  const otherId = await Effect.runPromise(personId("other@example.com"));
  const hasher = {
    hash: (secret: string) => Effect.succeed(`hashed:${secret}`),
    verify: (secret: string, hash: string) => Effect.succeed(hash === `hashed:${secret}`),
  };
  const created = await Effect.runPromise(
    createApiKey(
      emptyAuthenticationState(),
      { displayName: "Example Writer", personId: accountId, role: "member" },
      "Coding agent",
      now,
    ).pipe(
      Effect.provideService(IdGenerator, {
        generate: () => Effect.succeed("key_12345678"),
      }),
      Effect.provideService(SecretHasher, hasher),
      Effect.provideService(SecureToken, { generate: () => Effect.succeed("key-secret") }),
    ),
  );

  assert.equal(created.token, "key_12345678.key-secret");
  assert.equal(apiKeyBelongsTo(created.record, accountId), true);
  assert.equal(apiKeyBelongsTo(created.record, otherId), false);
  const authenticated = await Effect.runPromise(
    authenticateApiKey(created.state, created.token, now).pipe(
      Effect.provideService(SecretHasher, hasher),
    ),
  );
  assert.deepEqual(authenticated.principal, {
    displayName: "Example Writer",
    keyId: "key_12345678",
    kind: "api-key",
    personId: accountId,
    role: "member",
  });
  const legacyToken = await Effect.runPromise(
    authenticateApiKey(created.state, `inkling_${created.token}`, now).pipe(
      Effect.provideService(SecretHasher, hasher),
    ),
  );
  assert.deepEqual(legacyToken.principal, authenticated.principal);

  const otherUserRevocation = await Effect.runPromise(
    revokeApiKey(created.state, created.record.id, otherId, now).pipe(Effect.either),
  );
  assert.equal(Either.isLeft(otherUserRevocation), true);
  const revoked = await Effect.runPromise(
    revokeApiKey(created.state, created.record.id, accountId, now),
  );
  assert.equal(revoked.apiKeys[0]?.revokedAt, now);
});

test("private and confidential visibility share workspace-only authorization", async () => {
  const metadata = await Effect.runPromise(
    createDocumentMetadata({ id: "document_visibility1", title: "Decision" }, now),
  );
  const published = await Effect.runPromise(markPublished(metadata, metadata.headRevision, now));
  const anonymous: Principal = { kind: "anonymous" };

  const privateRead = await Effect.runPromise(
    authorizeDocument(anonymous, "read-published", published, now).pipe(Effect.either),
  );
  assert.equal(Either.isLeft(privateRead), true);

  const confidential = await Effect.runPromise(
    updateDocumentMetadata(published, { visibility: "confidential" }, 1, now),
  );
  const confidentialRead = await Effect.runPromise(
    authorizeDocument(anonymous, "read-published", confidential, now).pipe(Effect.either),
  );
  assert.equal(Either.isLeft(confidentialRead), true);

  const publicMetadata = await Effect.runPromise(
    updateDocumentMetadata(confidential, { visibility: "public" }, 2, now),
  );
  await Effect.runPromise(authorizeDocument(anonymous, "read-published", publicMetadata, now));
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

  const projected = await Effect.runPromise(
    applyCatalogSummary(active, catalogSummary(numbered, "Later RFC body")),
  );
  assert.equal(projected.entries.find((entry) => entry.documentId === numbered.id)?.rfcNumber, 2);
});

test("catalog search covers full bodies and Gmail-style metadata filters", async () => {
  const [authorId, otherPersonId] = await Effect.runPromise(
    Effect.all([personId("armin@example.com"), personId("else@example.com")]),
  );
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
        title: "Private planning notes",
        visibility: "confidential",
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
  assert.equal(
    searchCatalog(state, "author:me", { currentPersonId: authorId })[0]?.documentId,
    rfcMetadata.id,
  );
  assert.deepEqual(searchCatalog(state, "author:me", { currentPersonId: otherPersonId }), []);
  assert.equal(searchCatalog(state, "rfc:0042")[0]?.documentId, rfcMetadata.id);
  assert.equal(searchCatalog(state, "label:planning")[0]?.documentId, noteMetadata.id);
  assert.equal(searchCatalog(state, "is:note")[0]?.documentId, noteMetadata.id);
});

test("catalogs keep RFC number order while interleaving notes by activity", async () => {
  const [newerNote, latestRfc, middleNote, earlierRfc, olderNote] = await Effect.runPromise(
    Effect.all([
      createDocumentMetadata(
        { id: "document_newer_note", title: "Newer note" },
        "2026-08-05T00:00:00.000Z",
      ),
      createDocumentMetadata(
        { id: "document_rfc_54", rfcNumber: 54, title: "Latest RFC" },
        "2026-08-04T00:00:00.000Z",
      ),
      createDocumentMetadata(
        { id: "document_middle_note", title: "Middle note" },
        "2026-08-02T00:00:00.000Z",
      ),
      createDocumentMetadata(
        { id: "document_rfc_47", rfcNumber: 47, title: "Earlier RFC" },
        "2026-08-01T00:00:00.000Z",
      ),
      createDocumentMetadata(
        { id: "document_older_note", title: "Older note" },
        "2026-07-31T00:00:00.000Z",
      ),
    ]),
  );
  const state: WorkspaceCatalogState = {
    entries: [earlierRfc, olderNote, newerNote, latestRfc, middleNote].map((metadata) => ({
      creationKey: `cat:${metadata.id}`,
      documentId: metadata.id,
      rfcNumber: metadata.rfcNumber,
      status: "active" as const,
      summary: catalogSummary(metadata, metadata.title),
    })),
    nextRfcNumber: 55,
    people: [],
  };

  assert.deepEqual(
    searchCatalog(state, "").map((summary) => summary.title),
    ["Newer note", "Latest RFC", "Middle note", "Earlier RFC", "Older note"],
  );
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
