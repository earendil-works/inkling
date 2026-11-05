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
  createAuthorizationCode,
  createCommentThread,
  createDocumentMetadata,
  createWorkspaceSession,
  authenticateSession,
  documentId,
  documentTitleFromMarkdown,
  documentTrashExpiresAt,
  emptyCommentState,
  encodeBase62,
  filterCatalog,
  IdGenerator,
  isDocumentTrashExpired,
  markDeleted,
  markPublished,
  markRestored,
  normalizeDocumentMetadata,
  normalizeSearchText,
  parseCatalogSearchQuery,
  personId,
  purgeDocument,
  reserveDocument,
  resolveAuthorsByEmail,
  revokeApiKey,
  searchCatalog,
  SecureToken,
  takeAuthorizationCode,
  TokenHasher,
  verifyAuthorizationCode,
  emptyAuthenticationState,
  emptyWorkspaceCatalog,
  hasPendingPublicationChanges,
  identifierTag,
  isDocumentActionAllowed,
  sharePersonalDocument,
  documentActions,
  moveToWorkspace,
  taggedId,
  tombstoneDocument,
  updateDocumentMetadata,
  updateSharingPolicy,
  uuidV7Bytes,
} from "../src/index.ts";
import type {
  CatalogSummary,
  CommentActor,
  DocumentMetadata,
  PersonId,
  PersonReference,
  Principal,
  WorkspaceCatalogState,
} from "../src/index.ts";

const now = "2026-01-02T03:04:05.000Z";

/** Hashes as `hashed:<token>`; `legacy:<token>` stands for a superseded scheme. */
const fakeTokenHasher = {
  hash: (token: string) => Effect.succeed(`hashed:${token}`),
  isOutdated: (hash: string) => hash.startsWith("legacy:"),
  verify: (token: string, hash: string) =>
    Effect.succeed(hash === `hashed:${token}` || hash === `legacy:${token}`),
};

function person(id: PersonId, email: string): PersonReference {
  return { displayName: email, email, id };
}

function summaryIds(summaries: readonly CatalogSummary[]): readonly string[] {
  return summaries.map((summary) => summary.documentId).toSorted();
}

function catalogSummary(metadata: DocumentMetadata, body: string): CatalogSummary {
  return {
    approvers: metadata.approvers,
    authors: metadata.authors,
    documentId: metadata.id,
    excerpt: normalizeSearchText(body).slice(0, 240),
    labels: metadata.labels,
    metadata,
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
  const hasher = fakeTokenHasher;
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
      Effect.provideService(TokenHasher, hasher),
      Effect.provideService(SecureToken, tokens),
    ),
  );
  const authenticated = await Effect.runPromise(
    authenticateSession(created.state, created.token, now).pipe(
      Effect.provideService(TokenHasher, hasher),
    ),
  );
  assert.deepEqual(authenticated, {
    principal: {
      displayName: "Example Writer",
      kind: "workspace",
      personId: id,
      role: "member",
    },
    updatedRecord: undefined,
  });

  const legacyState = {
    ...created.state,
    sessions: created.state.sessions.map((session) => ({
      ...session,
      tokenHash: "legacy:session-secret",
    })),
  };
  const upgraded = await Effect.runPromise(
    authenticateSession(legacyState, created.token, now).pipe(
      Effect.provideService(TokenHasher, hasher),
    ),
  );
  assert.equal(upgraded.updatedRecord?.tokenHash, "hashed:session-secret");
});

test("legacy credentials without a domain identity are rejected", async () => {
  const hasher = fakeTokenHasher;
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
      Effect.provideService(TokenHasher, hasher),
      Effect.either,
    ),
  );
  const apiKey = await Effect.runPromise(
    authenticateApiKey(state, "inkling_legacy-key.key-secret", now).pipe(
      Effect.provideService(TokenHasher, hasher),
      Effect.either,
    ),
  );
  assert.equal(Either.isLeft(session), true);
  assert.equal(Either.isLeft(apiKey), true);
});

test("API keys belong to their creator and retain that user's role", async () => {
  const accountId = await Effect.runPromise(personId("writer@example.com"));
  const otherId = await Effect.runPromise(personId("other@example.com"));
  const hasher = fakeTokenHasher;
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
      Effect.provideService(TokenHasher, hasher),
      Effect.provideService(SecureToken, { generate: () => Effect.succeed("key-secret") }),
    ),
  );

  assert.equal(created.token, "key_12345678.key-secret");
  assert.equal(created.record.retainedSecret, "key-secret");
  assert.equal(apiKeyBelongsTo(created.record, accountId), true);
  assert.equal(apiKeyBelongsTo(created.record, otherId), false);
  const authenticated = await Effect.runPromise(
    authenticateApiKey(created.state, created.token, now).pipe(
      Effect.provideService(TokenHasher, hasher),
    ),
  );
  assert.deepEqual(authenticated.principal, {
    displayName: "Example Writer",
    keyId: "key_12345678",
    kind: "api-key",
    personId: accountId,
    role: "member",
  });
  assert.equal(authenticated.updatedRecord?.lastUsedAt, now);

  // Use is recorded at most hourly, so most requests write nothing.
  const used = { ...created.state, apiKeys: [{ ...created.record, lastUsedAt: now }] };
  const soonAfter = "2026-01-02T03:34:05.000Z";
  const hourAfter = "2026-01-02T04:04:05.000Z";
  const [quiet, recorded, upgraded] = await Promise.all(
    [
      authenticateApiKey(used, created.token, soonAfter),
      authenticateApiKey(used, created.token, hourAfter),
      authenticateApiKey(
        {
          ...used,
          apiKeys: [{ ...created.record, tokenHash: "legacy:key-secret" }],
        },
        created.token,
        soonAfter,
      ),
    ].map((effect) => Effect.runPromise(effect.pipe(Effect.provideService(TokenHasher, hasher)))),
  );
  assert.equal(quiet?.updatedRecord, undefined);
  assert.equal(recorded?.updatedRecord?.lastUsedAt, hourAfter);
  assert.equal(upgraded?.updatedRecord?.tokenHash, "hashed:key-secret");
  const legacyToken = await Effect.runPromise(
    authenticateApiKey(created.state, `inkling_${created.token}`, now).pipe(
      Effect.provideService(TokenHasher, hasher),
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

test("authorization codes are single-use and bound to client, redirect, and PKCE", async () => {
  const accountId = await Effect.runPromise(personId("writer@example.com"));
  const hasher = fakeTokenHasher;
  const grant = {
    clientId: "mcp_client",
    clientName: "Agent",
    codeChallenge: "challenge",
    redirectUri: "http://127.0.0.1:3000/callback",
  };
  const created = await Effect.runPromise(
    createAuthorizationCode(
      emptyAuthenticationState(),
      { displayName: "Example Writer", personId: accountId, role: "member" },
      grant,
      now,
    ).pipe(
      Effect.provideService(IdGenerator, { generate: () => Effect.succeed("oac_1") }),
      Effect.provideService(TokenHasher, hasher),
      Effect.provideService(SecureToken, { generate: () => Effect.succeed("code-secret") }),
    ),
  );
  assert.equal(created.token, "oac_1.code-secret");
  assert.equal(created.state.authorizationCodes[0]?.tokenHash, "hashed:code-secret");

  const verify = (
    taken: ReturnType<typeof takeAuthorizationCode>,
    overrides: Partial<typeof grant> = {},
    at = now,
  ) =>
    taken.record === undefined || taken.secret === undefined
      ? Promise.resolve(Either.left("missing"))
      : Effect.runPromise(
          verifyAuthorizationCode(taken.record, taken.secret, { ...grant, ...overrides }, at).pipe(
            Effect.provideService(TokenHasher, hasher),
            Effect.either,
          ),
        );

  const taken = takeAuthorizationCode(created.state, created.token, now);
  assert.equal(taken.state.authorizationCodes.length, 0);
  assert.deepEqual(
    await verify(taken),
    Either.right({ displayName: "Example Writer", personId: accountId, role: "member" }),
  );
  assert.equal(takeAuthorizationCode(taken.state, created.token, now).record, undefined);

  const mismatches = await Promise.all(
    [
      { codeChallenge: "other" },
      { clientId: "mcp_other" },
      { redirectUri: "http://127.0.0.1:3000/elsewhere" },
    ].map((overrides) =>
      verify(takeAuthorizationCode(created.state, created.token, now), overrides),
    ),
  );
  assert.ok(mismatches.every(Either.isLeft));
  const forged = takeAuthorizationCode(created.state, "oac_1.wrong", now);
  assert.equal(Either.isLeft(await verify(forged)), true);

  const later = new Date(Date.parse(now) + 6 * 60 * 1000).toISOString();
  const expired = takeAuthorizationCode(created.state, created.token, later);
  assert.equal(expired.record, undefined);
  assert.equal(expired.state.authorizationCodes.length, 0);
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

test("deleted documents remain restorable for 30 days before permanent deletion", async () => {
  const metadata = await Effect.runPromise(
    createDocumentMetadata({ id: "document_trash_test", rfcNumber: 7, title: "Recoverable" }, now),
  );
  const administratorId = await Effect.runPromise(personId("admin@example.com"));
  const memberId = await Effect.runPromise(personId("member@example.com"));
  const administrator: Principal = {
    kind: "workspace",
    personId: administratorId,
    role: "administrator",
  };
  const member: Principal = { kind: "workspace", personId: memberId, role: "member" };
  const deleted = await Effect.runPromise(markDeleted(metadata, 0, now));

  assert.equal(deleted.deletedAt, now);
  assert.equal(deleted.sharing.access, "disabled");
  assert.equal(await Effect.runPromise(markDeleted(deleted, 0, now)), deleted);
  assert.equal(documentTrashExpiresAt(deleted), "2026-02-01T03:04:05.000Z");
  assert.equal(isDocumentTrashExpired(deleted, "2026-02-01T03:04:04.999Z"), false);
  assert.equal(isDocumentTrashExpired(deleted, "2026-02-01T03:04:05.000Z"), true);
  await Effect.runPromise(authorizeDocument(administrator, "read-working", deleted, now));
  await Effect.runPromise(authorizeDocument(administrator, "edit-body", deleted, now));
  await Effect.runPromise(authorizeDocument(member, "read-working", deleted, now));
  await Effect.runPromise(authorizeDocument(member, "edit-body", deleted, now));
  await Effect.runPromise(authorizeDocument(administrator, "restore", deleted, now));
  await Effect.runPromise(authorizeDocument(administrator, "hard-delete", deleted, now));
  assert.equal(
    Either.isLeft(
      await Effect.runPromise(
        authorizeDocument(member, "restore", deleted, now).pipe(Effect.either),
      ),
    ),
    true,
  );
  assert.equal(
    Either.isLeft(
      await Effect.runPromise(
        authorizeDocument(administrator, "publish", deleted, now).pipe(Effect.either),
      ),
    ),
    true,
  );

  const restored = await Effect.runPromise(
    markRestored(deleted, deleted.headRevision, "2026-01-03T00:00:00.000Z"),
  );
  assert.equal(restored.deletedAt, undefined);
  assert.equal(restored.headRevision, 2);
  assert.equal(
    Either.isLeft(
      await Effect.runPromise(
        markRestored(restored, restored.headRevision, now).pipe(Effect.either),
      ),
    ),
    true,
  );

  const reserved = await Effect.runPromise(
    reserveDocument(emptyWorkspaceCatalog(), {
      allocateRfc: false,
      creationKey: "trash-test",
      documentId: metadata.id,
      requestedRfcNumber: 7,
    }),
  );
  const active = await Effect.runPromise(activateDocument(reserved.state, metadata.id));
  const projected = await Effect.runPromise(
    applyCatalogSummary(active, catalogSummary(deleted, "Recoverable body")),
  );
  const trashed = await Effect.runPromise(tombstoneDocument(projected, metadata.id));
  assert.deepEqual(
    searchCatalog(trashed, "", { onlyDeleted: true }).map((summary) => summary.documentId),
    [metadata.id],
  );
  assert.deepEqual(searchCatalog(trashed, ""), []);
  const purged = await Effect.runPromise(purgeDocument(trashed, metadata.id));
  assert.equal(purged.entries.length, 1);
  assert.equal(purged.entries[0]?.status, "purged");
  assert.equal(purged.entries[0]?.summary, undefined);
  assert.equal(purged.nextRfcNumber, trashed.nextRfcNumber);
  const reusedNumber = await Effect.runPromise(
    reserveDocument(purged, {
      allocateRfc: false,
      creationKey: "replacement",
      documentId: "document_replacement",
      requestedRfcNumber: 7,
    }).pipe(Effect.either),
  );
  assert.equal(Either.isLeft(reusedNumber) && reusedNumber.left.code, "duplicate_rfc_number");
});

test("personal documents are invisible to everyone but their owner until moved", async () => {
  const ownerId = await Effect.runPromise(personId("owner@example.com"));
  const administratorId = await Effect.runPromise(personId("admin@example.com"));
  const memberId = await Effect.runPromise(personId("member@example.com"));
  const owner: Principal = { kind: "workspace", personId: ownerId, role: "member" };
  const ownerKey: Principal = {
    keyId: "key_owner",
    kind: "api-key",
    personId: ownerId,
    role: "member",
  };
  const administrator: Principal = {
    kind: "workspace",
    personId: administratorId,
    role: "administrator",
  };
  const member: Principal = { kind: "workspace", personId: memberId, role: "member" };
  const system: Principal = {
    kind: "workspace",
    personId: administratorId,
    role: "administrator",
    system: true,
  };
  const capability: Principal = {
    access: "edit",
    documentId: "document_personal1",
    generation: 0,
    kind: "capability",
  };
  const personal = await Effect.runPromise(
    createDocumentMetadata(
      { id: "document_personal1", personalOwner: ownerId, title: "Private thoughts" },
      now,
    ),
  );
  const allowed = (principal: Principal, metadata: DocumentMetadata): readonly string[] =>
    documentActions.filter((action) => isDocumentActionAllowed(principal, action, metadata, now));

  for (const outsider of [administrator, member, capability, { kind: "anonymous" } as const]) {
    assert.deepEqual(allowed(outsider, personal), []);
  }
  const ownerActions = [
    "discover",
    "read-working",
    "read-history",
    "comment",
    "edit-body",
    "edit-metadata",
    "manage-comments",
    "manage-sharing",
    "delete",
    "restore",
    "restore-history",
    "move-to-workspace",
  ];
  assert.deepEqual(allowed(owner, personal), ownerActions);
  assert.deepEqual(allowed(ownerKey, personal), ownerActions);
  assert.equal(isDocumentActionAllowed(system, "read-working", personal, now), true);

  const trashed = await Effect.runPromise(markDeleted(personal, personal.headRevision, now));
  assert.deepEqual(allowed(administrator, trashed), []);
  assert.equal(isDocumentActionAllowed(owner, "restore", trashed, now), true);
  assert.equal(isDocumentActionAllowed(owner, "hard-delete", trashed, now), true);
  assert.equal(isDocumentActionAllowed(owner, "move-to-workspace", trashed, now), false);

  const numbered = await Effect.runPromise(assignRfcNumber(personal, 12, now).pipe(Effect.either));
  assert.equal(Either.isLeft(numbered) && numbered.left.code, "personal_rfc");
  const createdAsRfc = await Effect.runPromise(
    createDocumentMetadata(
      { id: "document_personal2", personalOwner: ownerId, rfcNumber: 3, title: "RFC" },
      now,
    ).pipe(Effect.either),
  );
  assert.equal(Either.isLeft(createdAsRfc) && createdAsRfc.left.code, "personal_rfc");

  const stale = await Effect.runPromise(
    moveToWorkspace(personal, personal.headRevision + 1, now).pipe(Effect.either),
  );
  assert.equal(Either.isLeft(stale) && stale.left.code, "revision_conflict");
  const shared = await Effect.runPromise(moveToWorkspace(personal, personal.headRevision, now));
  assert.equal("personalOwner" in shared, false);
  assert.equal(shared.headRevision, personal.headRevision + 1);
  assert.equal(isDocumentActionAllowed(member, "edit-body", shared, now), true);
  assert.equal(isDocumentActionAllowed(administrator, "publish", shared, now), true);
  assert.equal(isDocumentActionAllowed(owner, "move-to-workspace", shared, now), false);
  const again = await Effect.runPromise(
    moveToWorkspace(shared, shared.headRevision, now).pipe(Effect.either),
  );
  assert.equal(Either.isLeft(again) && again.left.code, "document_not_personal");

  const workspaceNote = await Effect.runPromise(
    createDocumentMetadata({ id: "document_workspace1", title: "Shared note" }, now),
  );
  const catalog = await Effect.runPromise(
    Effect.reduce([personal, workspaceNote], emptyWorkspaceCatalog(), (current, metadata) =>
      reserveDocument(current, {
        allocateRfc: false,
        creationKey: metadata.id,
        documentId: metadata.id,
      }).pipe(
        Effect.flatMap((reserved) => activateDocument(reserved.state, metadata.id)),
        Effect.flatMap((active) =>
          applyCatalogSummary(active, catalogSummary(metadata, metadata.title)),
        ),
      ),
    ),
  );
  const visibleTo =
    (principal: Principal) =>
    (summary: CatalogSummary): boolean =>
      summary.metadata === undefined ||
      isDocumentActionAllowed(principal, "discover", summary.metadata, now);
  assert.deepEqual(summaryIds(searchCatalog(catalog, "", { visible: visibleTo(member) })), [
    workspaceNote.id,
  ]);
  assert.deepEqual(summaryIds(searchCatalog(catalog, "", { visible: visibleTo(owner) })), [
    personal.id,
    workspaceNote.id,
  ]);
  assert.deepEqual(
    summaryIds(
      searchCatalog(catalog, "is:personal", {
        currentPersonId: ownerId,
        visible: visibleTo(owner),
      }),
    ),
    [personal.id],
  );
  assert.deepEqual(
    summaryIds(filterCatalog(catalog, parseCatalogSearchQuery(""), { visible: visibleTo(member) })),
    [workspaceNote.id],
  );
});

test("personal documents open to the people and links their owner shares them with", async () => {
  const ownerId = await Effect.runPromise(personId("owner@example.com"));
  const collaboratorId = await Effect.runPromise(personId("friend@example.com"));
  const administratorId = await Effect.runPromise(personId("admin@example.com"));
  const owner: Principal = { kind: "workspace", personId: ownerId, role: "member" };
  const collaborator: Principal = { kind: "workspace", personId: collaboratorId, role: "member" };
  const administrator: Principal = {
    kind: "workspace",
    personId: administratorId,
    role: "administrator",
  };
  const created = await Effect.runPromise(
    createDocumentMetadata(
      { id: "document_shared01", personalOwner: ownerId, title: "Shared thoughts" },
      now,
    ),
  );
  const allowed = (principal: Principal, metadata: DocumentMetadata): readonly string[] =>
    documentActions.filter((action) => isDocumentActionAllowed(principal, action, metadata, now));

  const notPersonal = await Effect.runPromise(
    sharePersonalDocument(
      { ...created, personalOwner: undefined },
      [person(collaboratorId, "friend@example.com")],
      created.headRevision,
      now,
    ).pipe(Effect.either),
  );
  assert.equal(Either.isLeft(notPersonal) && notPersonal.left.code, "document_not_personal");

  const shared = await Effect.runPromise(
    sharePersonalDocument(
      created,
      [
        person(collaboratorId, "friend@example.com"),
        person(collaboratorId, "friend@example.com"),
        person(ownerId, "owner@example.com"),
      ],
      created.headRevision,
      now,
    ),
  );
  assert.deepEqual(
    shared.sharedWith?.map((entry) => entry.id),
    [collaboratorId],
  );
  assert.deepEqual(allowed(collaborator, shared), [
    "discover",
    "read-working",
    "read-history",
    "comment",
    "edit-body",
    "edit-metadata",
    "restore-history",
  ]);
  assert.deepEqual(allowed(administrator, shared), []);
  const trashed = await Effect.runPromise(markDeleted(shared, shared.headRevision, now));
  assert.deepEqual(allowed(collaborator, trashed), []);

  const unshared = await Effect.runPromise(
    sharePersonalDocument(shared, [], shared.headRevision, now),
  );
  assert.equal("sharedWith" in unshared, false);
  assert.deepEqual(allowed(collaborator, unshared), []);

  const linked = await Effect.runPromise(
    updateSharingPolicy(unshared, "comment", unshared.headRevision, now),
  );
  const grant = {
    access: "comment" as const,
    documentId: linked.id,
    generation: linked.sharing.generation,
  };
  const signedInWithLink: Principal = { ...administrator, capability: grant };
  assert.deepEqual(allowed(signedInWithLink, linked), ["discover", "read-working", "comment"]);
  assert.deepEqual(allowed({ ...grant, kind: "capability" }, linked), [
    "discover",
    "read-working",
    "comment",
  ]);
  assert.deepEqual(
    allowed({ ...administrator, capability: { ...grant, documentId: "document_other01" } }, linked),
    [],
  );
  const revoked = await Effect.runPromise(
    updateSharingPolicy(linked, "disabled", linked.headRevision, now),
  );
  assert.deepEqual(allowed(signedInWithLink, revoked), []);
  const workspaceDocument = await Effect.runPromise(
    moveToWorkspace(shared, shared.headRevision, now),
  );
  assert.equal("sharedWith" in workspaceDocument, false);

  const reserved = await Effect.runPromise(
    reserveDocument(emptyWorkspaceCatalog(), {
      allocateRfc: false,
      creationKey: shared.id,
      documentId: shared.id,
    }),
  );
  const active = await Effect.runPromise(activateDocument(reserved.state, shared.id));
  const catalog = await Effect.runPromise(
    applyCatalogSummary(active, catalogSummary(shared, shared.title)),
  );
  const search = (query: string, principal: Principal, reader: PersonId): readonly string[] =>
    summaryIds(
      searchCatalog(catalog, query, {
        currentPersonId: reader,
        visible: (summary) =>
          summary.metadata !== undefined &&
          isDocumentActionAllowed(principal, "discover", summary.metadata, now),
      }),
    );
  assert.deepEqual(search("is:shared", collaborator, collaboratorId), [shared.id]);
  assert.deepEqual(search("is:personal", collaborator, collaboratorId), []);
  assert.deepEqual(search("is:shared", owner, ownerId), []);
  assert.deepEqual(search("is:personal", owner, ownerId), [shared.id]);
  assert.deepEqual(search("", administrator, administratorId), []);
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

test("capability access is link-specific within a shared document", async () => {
  const metadata = await Effect.runPromise(
    createDocumentMetadata({ id: "document_multilink1", title: "Decision" }, now),
  );
  const shared = await Effect.runPromise(updateSharingPolicy(metadata, "edit", 0, now));
  const viewer: Principal = {
    access: "view",
    documentId: metadata.id,
    generation: shared.sharing.generation,
    kind: "capability",
  };

  await Effect.runPromise(authorizeDocument(viewer, "read-working", shared, now));
  const deniedEdit = await Effect.runPromise(
    authorizeDocument(viewer, "edit-body", shared, now).pipe(Effect.either),
  );
  assert.equal(Either.isLeft(deniedEdit), true);
  const deniedHistory = await Effect.runPromise(
    authorizeDocument(viewer, "read-history", shared, now).pipe(Effect.either),
  );
  assert.equal(Either.isLeft(deniedHistory), true);
  const deniedRestore = await Effect.runPromise(
    authorizeDocument({ ...viewer, access: "edit" }, "restore-history", shared, now).pipe(
      Effect.either,
    ),
  );
  assert.equal(Either.isLeft(deniedRestore), true);

  const expiredViewer: Principal = { ...viewer, expiresAt: "2025-01-01T00:00:00.000Z" };
  const deniedExpired = await Effect.runPromise(
    authorizeDocument(expiredViewer, "read-working", shared, now).pipe(Effect.either),
  );
  assert.equal(Either.isLeft(deniedExpired), true);
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
  assert.deepEqual(searchCatalog(state, '"durable checkpoint"'), []);
  const fullText = searchCatalog(state, '"durable checkpoint"', {
    bodyMatches: new Map([["durable checkpoint", new Set([rfcMetadata.id])]]),
  });
  assert.equal(fullText[0]?.documentId, rfcMetadata.id);
  assert.deepEqual(
    searchCatalog(state, "-budget", {
      bodyMatches: new Map([["budget", new Set([noteMetadata.id])]]),
    }).map((summary) => summary.documentId),
    [rfcMetadata.id],
  );
  assert.deepEqual(
    filterCatalog(state, parseCatalogSearchQuery("durable label:platform -is:confidential")).map(
      (summary) => summary.documentId,
    ),
    [rfcMetadata.id],
  );
  assert.equal(normalizeSearchText("Naïve Café"), "naive cafe");
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
