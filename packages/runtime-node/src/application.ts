import { Effect, Fiber, Layer, Schema, Stream } from "effect";

import {
  activateDocument,
  applyCatalogSummary,
  authenticateApiKey,
  authenticateSession,
  AuthenticationError,
  AuthorizationError,
  BodyEditError,
  createApiKey,
  createDocumentMetadata,
  Digest,
  documentActions,
  documentId,
  DomainError,
  DurableDocumentJournal,
  emptyAuthenticationState,
  emptyWorkspaceCatalog,
  IdGenerator,
  isDocumentActionAllowed,
  ObjectStore,
  personId,
  readLineRange,
  reserveDocument,
  revokeApiKey,
  searchCatalog,
  SecretHasher,
  SecureToken,
  setupOwner,
  StorageError,
  tombstoneDocument,
  WorkspaceStateStore,
  loginOwner,
  logoutSession,
  normalizeSearchText,
} from "@earendil-works/jot-core";
import type {
  ApiKeyRecord,
  AuthenticationState,
  CapabilityAccess,
  CatalogSummary,
  CommentActor,
  DocumentMetadata,
  MetadataPatch,
  PersonReference,
  Principal,
  RelatedDocumentReference,
  WorkspaceCatalogState,
} from "@earendil-works/jot-core";
import {
  CollaborationError,
  encodeBase64,
  loadDocumentRevision,
  makeDocumentAuthority,
  RecoveryError,
} from "@earendil-works/jot-collaboration";
import type { DocumentAuthorityService, DocumentSnapshot } from "@earendil-works/jot-collaboration";
import { ApplicationError, JotApplication } from "@earendil-works/jot-backend";
import type {
  CollaborationConnection,
  JotApplicationService,
  RequestCredentials,
} from "@earendil-works/jot-backend";
import type {
  ApiKeyCreated,
  ApiKeyDto,
  CatalogResponse,
  CommentStateDto,
  DocumentMetadataDto,
  DocumentResponse,
  MetadataPatchRequest,
  PublicDocumentResponse,
  ServerCollaborationMessage,
  ShareResponse,
} from "@earendil-works/jot-protocol";
import { MarkdownRenderer } from "@earendil-works/jot-renderer";

interface CapabilityRecord {
  readonly id: string;
  readonly documentId: string;
  readonly tokenHash: string;
  readonly generation: number;
  readonly access: Exclude<CapabilityAccess, "disabled">;
  readonly expiresAt?: string | undefined;
}

interface LocalWorkspaceState {
  readonly schemaVersion: 1;
  readonly workspaceId: string;
  readonly catalog: WorkspaceCatalogState;
  readonly authentication: AuthenticationState;
  readonly capabilities: readonly CapabilityRecord[];
}

const persistedStateSchema = Schema.Struct({
  authentication: Schema.Unknown,
  capabilities: Schema.Array(
    Schema.Struct({
      access: Schema.Literal("view", "comment", "edit"),
      documentId: Schema.String,
      expiresAt: Schema.optional(Schema.String),
      generation: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
      id: Schema.String,
      tokenHash: Schema.String,
    }),
  ),
  catalog: Schema.Unknown,
  schemaVersion: Schema.Literal(1),
  workspaceId: Schema.String,
});

export interface LocalApplicationOptions {
  readonly workspaceId?: string | undefined;
}

export function makeLocalJotApplication(
  options: LocalApplicationOptions = {},
): Effect.Effect<
  JotApplicationService,
  StorageError,
  | typeof WorkspaceStateStore.Service
  | typeof ObjectStore.Service
  | typeof DurableDocumentJournal.Service
  | typeof Digest.Service
  | typeof SecretHasher.Service
  | typeof SecureToken.Service
  | typeof IdGenerator.Service
  | typeof MarkdownRenderer.Service
> {
  return Effect.gen(function* () {
    const stateStore = yield* WorkspaceStateStore;
    const objectStore = yield* ObjectStore;
    const journal = yield* DurableDocumentJournal;
    const digest = yield* Digest;
    const hasher = yield* SecretHasher;
    const tokens = yield* SecureToken;
    const ids = yield* IdGenerator;
    const renderer = yield* MarkdownRenderer;
    const stateMutex = yield* Effect.makeSemaphore(1);
    const roomMutex = yield* Effect.makeSemaphore(1);
    const rooms = new Map<string, DocumentAuthorityService>();
    const checkpointFibers = new Map<string, Fiber.RuntimeFiber<void, never>>();
    const dirtySince = new Map<string, number>();
    let state = yield* loadWorkspaceState(stateStore, options.workspaceId ?? "local");
    const ownerId = yield* personId("owner@local").pipe(Effect.mapError(toStorageError));
    const ownerPrincipal: Principal = { kind: "workspace", personId: ownerId, role: "owner" };

    const saveState = (next: LocalWorkspaceState): Effect.Effect<void, StorageError> =>
      stateStore.save(next).pipe(Effect.tap(() => Effect.sync(() => (state = next))));

    const withState = stateMutex.withPermits(1);

    const provideAuthorityDependencies = <A, E>(
      effect: Effect.Effect<
        A,
        E,
        typeof ObjectStore.Service | typeof DurableDocumentJournal.Service | typeof Digest.Service
      >,
    ): Effect.Effect<A, E> =>
      effect.pipe(
        Effect.provideService(ObjectStore, objectStore),
        Effect.provideService(DurableDocumentJournal, journal),
        Effect.provideService(Digest, digest),
      );

    const getRoom = (
      rawDocumentId: string,
    ): Effect.Effect<DocumentAuthorityService, ApplicationError> =>
      roomMutex.withPermits(1)(
        Effect.gen(function* () {
          const id = yield* documentId(rawDocumentId).pipe(Effect.mapError(toApplicationError));
          const existing = rooms.get(id);
          if (existing !== undefined) {
            return existing;
          }
          const registered = state.catalog.entries.find(
            (entry) => entry.documentId === id && entry.status !== "pending",
          );
          if (registered === undefined) {
            return yield* applicationFailure("not_found", "The document does not exist.", 404);
          }
          const room = yield* provideAuthorityDependencies(
            makeDocumentAuthority({ documentId: id, workspaceId: state.workspaceId }),
          ).pipe(Effect.mapError(toApplicationError));
          rooms.set(id, room);
          return room;
        }),
      );

    const scheduleCheckpoint = (room: DocumentAuthorityService): Effect.Effect<void> =>
      Effect.gen(function* () {
        const existing = checkpointFibers.get(room.documentId);
        if (existing !== undefined) {
          yield* Fiber.interrupt(existing);
        }
        const started = dirtySince.get(room.documentId) ?? Date.now();
        dirtySince.set(room.documentId, started);
        const delay = Date.now() - started >= 30_000 ? 0 : 1_500;
        const fiber = yield* room.checkpoint(new Date().toISOString()).pipe(
          Effect.delay(delay),
          Effect.tapError((error) => Effect.logError("Document checkpoint failed", error)),
          Effect.ignore,
          Effect.ensuring(
            Effect.sync(() => {
              checkpointFibers.delete(room.documentId);
              dirtySince.delete(room.documentId);
            }),
          ),
          Effect.forkDaemon,
        );
        checkpointFibers.set(room.documentId, fiber);
      });

    const resolvePrincipal = (
      credentials: RequestCredentials,
      targetDocumentId?: string,
    ): Effect.Effect<Principal, ApplicationError> =>
      withState(
        Effect.gen(function* () {
          const now = new Date().toISOString();
          if (credentials.bearerToken !== undefined) {
            const authenticated = yield* authenticateApiKey(
              state.authentication,
              credentials.bearerToken,
              now,
            ).pipe(
              Effect.provideService(SecretHasher, hasher),
              Effect.mapError(toApplicationError),
            );
            yield* saveState({ ...state, authentication: authenticated.state }).pipe(
              Effect.mapError(toApplicationError),
            );
            return authenticated.principal;
          }
          if (credentials.sessionToken !== undefined) {
            return yield* authenticateSession(
              state.authentication,
              credentials.sessionToken,
              now,
            ).pipe(
              Effect.provideService(SecretHasher, hasher),
              Effect.mapError(toApplicationError),
            );
          }
          if (credentials.capabilityToken !== undefined && targetDocumentId !== undefined) {
            return yield* resolveCapability(
              state,
              credentials.capabilityToken,
              targetDocumentId,
              credentials.guestName,
              hasher,
            );
          }
          return { kind: "anonymous" } as const;
        }),
      );

    const snapshotFor = (
      room: DocumentAuthorityService,
      principal: Principal,
      startLine?: number,
      endLine?: number,
    ): Effect.Effect<DocumentResponse, ApplicationError> =>
      room.snapshot(principal, new Date().toISOString()).pipe(
        Effect.mapError(toApplicationError),
        Effect.flatMap((snapshot) =>
          startLine === undefined && endLine === undefined
            ? Effect.succeed(toDocumentResponse(snapshot))
            : readLineRange(snapshot.body, {
                end: endLine ?? Number.MAX_SAFE_INTEGER,
                start: startLine ?? 1,
              }).pipe(
                Effect.mapError(toApplicationError),
                Effect.map((body) => toDocumentResponse({ ...snapshot, body })),
              ),
        ),
      );

    const projectDocument = (
      room: DocumentAuthorityService,
    ): Effect.Effect<void, ApplicationError> =>
      room.snapshot(ownerPrincipal, new Date().toISOString()).pipe(
        Effect.mapError(toApplicationError),
        Effect.flatMap((snapshot) =>
          withState(
            applyCatalogSummary(state.catalog, summaryFromSnapshot(snapshot)).pipe(
              Effect.mapError(toApplicationError),
              Effect.flatMap((catalog) =>
                saveState({ ...state, catalog }).pipe(Effect.mapError(toApplicationError)),
              ),
            ),
          ),
        ),
      );

    const afterMutation = (
      room: DocumentAuthorityService,
    ): Effect.Effect<DocumentResponse, ApplicationError> =>
      Effect.gen(function* () {
        yield* projectDocument(room);
        yield* scheduleCheckpoint(room);
        return yield* snapshotFor(room, ownerPrincipal);
      });

    const commentActor = (
      principal: Principal,
      guestName: string | undefined,
    ): Effect.Effect<CommentActor, ApplicationError> =>
      Effect.gen(function* () {
        if (principal.kind === "workspace" || principal.kind === "api-key") {
          return { displayName: "Owner", id: principal.personId, manageAll: true };
        }
        if (principal.kind === "capability" && principal.guestId !== undefined) {
          const displayName = guestName?.trim();
          if (displayName === undefined || displayName.length === 0 || displayName.length > 200) {
            return yield* applicationFailure(
              "guest_name_required",
              "A display name is required for capability comments.",
              400,
            );
          }
          return { displayName, id: principal.guestId, manageAll: false };
        }
        return yield* applicationFailure("forbidden", "This principal cannot comment.", 403);
      });

    const service: JotApplicationService = {
      connectCollaboration: (credentials, rawDocumentId, stateVector) =>
        Effect.gen(function* () {
          const room = yield* getRoom(rawDocumentId);
          const principal = yield* resolvePrincipal(credentials, rawDocumentId);
          const now = new Date().toISOString();
          const snapshot = yield* (
            stateVector === undefined
              ? room.snapshot(principal, now)
              : room.synchronize(principal, stateVector, now)
          ).pipe(Effect.mapError(toApplicationError));
          const actions = allowedActions(principal, snapshot.metadata, now);
          const events = room.events.pipe(
            Stream.map((event): ServerCollaborationMessage => {
              switch (event.type) {
                case "body-update":
                  return {
                    clientUpdateId: event.accepted.clientUpdateId,
                    documentRevision: event.accepted.revision,
                    serverSequence: event.accepted.sequence,
                    type: "update-accepted",
                    update: encodeBase64(event.accepted.update),
                  };
                case "comments-changed":
                  return {
                    comments: event.comments as CommentStateDto,
                    revision: event.revision,
                    type: "comments-changed",
                  };
                case "metadata-changed":
                case "published":
                  return {
                    metadata: event.metadata as DocumentMetadataDto,
                    type: "metadata-changed",
                  };
                case "sharing-changed":
                  return {
                    actions: allowedActions(principal, event.metadata, new Date().toISOString()),
                    type: "permission-changed",
                  };
                case "resynchronize":
                  return { reason: event.reason, type: "resynchronize" };
              }
            }),
          );
          const connection: CollaborationConnection = {
            acceptUpdate: (update, clientUpdateId) =>
              room
                .acceptBodyUpdate(principal, update, clientUpdateId, new Date().toISOString())
                .pipe(
                  Effect.mapError(toApplicationError),
                  Effect.tap(() => scheduleCheckpoint(room)),
                  Effect.tap(() => projectDocument(room).pipe(Effect.ignore, Effect.forkDaemon)),
                  Effect.asVoid,
                ),
            events,
            welcome: {
              actions,
              comments: snapshot.comments as CommentStateDto,
              metadata: snapshot.metadata as DocumentMetadataDto,
              protocolVersion: 1,
              sequence: snapshot.sequence,
              stateUpdate: encodeBase64(snapshot.stateUpdate),
              type: "welcome",
            },
          };
          return connection;
        }),
      authenticationStatus: (credentials) =>
        Effect.gen(function* () {
          const needsSetup = state.authentication.ownerPasswordHash === undefined;
          if (needsSetup) {
            return { authenticated: false, needsSetup: true };
          }
          const principal = yield* resolvePrincipal(credentials).pipe(
            Effect.catchAll(() => Effect.succeed({ kind: "anonymous" } as const)),
          );
          return principal.kind === "workspace" || principal.kind === "api-key"
            ? {
                authenticated: true,
                needsSetup: false,
                principal: { displayName: "Owner", id: principal.personId, role: principal.role },
              }
            : { authenticated: false, needsSetup: false };
        }),
      createApiKey: (credentials, label) =>
        Effect.gen(function* () {
          const principal = yield* resolvePrincipal(credentials);
          yield* requireOwner(principal);
          return yield* withState(
            createApiKey(state.authentication, label, new Date().toISOString()).pipe(
              Effect.provideService(SecretHasher, hasher),
              Effect.provideService(SecureToken, tokens),
              Effect.mapError(toApplicationError),
              Effect.flatMap((created) =>
                saveState({ ...state, authentication: created.state }).pipe(
                  Effect.mapError(toApplicationError),
                  Effect.as({
                    key: created.token,
                    metadata: apiKeyDto(created.record),
                  } satisfies ApiKeyCreated),
                ),
              ),
            ),
          );
        }),
      createDocument: (credentials, request) =>
        Effect.gen(function* () {
          const principal = yield* resolvePrincipal(credentials);
          yield* requireOwner(principal);
          const now = new Date().toISOString();
          const generatedId = yield* ids.generate("doc");
          const reservation = yield* withState(
            reserveDocument(state.catalog, {
              allocateRfc: request.allocateRfc ?? false,
              creationKey: request.creationKey,
              documentId: generatedId,
              requestedRfcNumber: request.requestedRfcNumber,
            }).pipe(
              Effect.mapError(toApplicationError),
              Effect.tap(({ state: catalog }) =>
                saveState({ ...state, catalog }).pipe(Effect.mapError(toApplicationError)),
              ),
            ),
          );
          const metadata = yield* createDocumentMetadata(
            {
              id: reservation.entry.documentId,
              rfcNumber: reservation.entry.rfcNumber,
              title: request.title,
            },
            now,
          ).pipe(Effect.mapError(toApplicationError));
          const room = yield* provideAuthorityDependencies(
            makeDocumentAuthority({
              documentId: reservation.entry.documentId,
              initialBody: request.body ?? "",
              initialMetadata: metadata,
              workspaceId: state.workspaceId,
            }),
          ).pipe(Effect.mapError(toApplicationError));
          rooms.set(room.documentId, room);
          yield* room.checkpoint(now).pipe(Effect.mapError(toApplicationError));
          const snapshot = yield* room
            .snapshot(ownerPrincipal, now)
            .pipe(Effect.mapError(toApplicationError));
          yield* withState(
            activateDocument(state.catalog, room.documentId).pipe(
              Effect.flatMap((catalog) =>
                applyCatalogSummary(catalog, summaryFromSnapshot(snapshot)),
              ),
              Effect.mapError(toApplicationError),
              Effect.flatMap((catalog) =>
                saveState({ ...state, catalog }).pipe(Effect.mapError(toApplicationError)),
              ),
            ),
          );
          return toDocumentResponse(snapshot);
        }),
      createThread: (credentials, rawDocumentId, request) =>
        Effect.gen(function* () {
          const room = yield* getRoom(rawDocumentId);
          const principal = yield* resolvePrincipal(credentials, rawDocumentId);
          const actor = yield* commentActor(principal, request.authorDisplayName);
          const threadId = yield* ids.generate("thread");
          const messageId = yield* ids.generate("message");
          const comments = yield* (
            "anchor" in request
              ? room.createThread(
                  principal,
                  { anchor: request.anchor, body: request.body, id: threadId, messageId },
                  actor,
                  new Date().toISOString(),
                )
              : room.createThreadAtOffsets(
                  principal,
                  {
                    body: request.body,
                    end: request.selection.end,
                    id: threadId,
                    messageId,
                    start: request.selection.start,
                  },
                  actor,
                  new Date().toISOString(),
                )
          ).pipe(Effect.mapError(toApplicationError));
          yield* projectDocument(room);
          yield* scheduleCheckpoint(room);
          return comments as CommentStateDto;
        }),
      deleteDocument: (credentials, rawDocumentId, expectedRevision) =>
        Effect.gen(function* () {
          const room = yield* getRoom(rawDocumentId);
          const principal = yield* resolvePrincipal(credentials, rawDocumentId);
          yield* room
            .deleteDocument(principal, expectedRevision, new Date().toISOString())
            .pipe(Effect.mapError(toApplicationError));
          yield* withState(
            tombstoneDocument(state.catalog, room.documentId).pipe(
              Effect.mapError(toApplicationError),
              Effect.flatMap((catalog) =>
                saveState({ ...state, catalog }).pipe(Effect.mapError(toApplicationError)),
              ),
            ),
          );
          yield* room
            .checkpoint(new Date().toISOString())
            .pipe(Effect.mapError(toApplicationError));
        }),
      deleteMessage: (credentials, rawDocumentId, threadId, messageId) =>
        Effect.gen(function* () {
          const room = yield* getRoom(rawDocumentId);
          const principal = yield* resolvePrincipal(credentials, rawDocumentId);
          const actor = yield* commentActor(principal, credentials.guestName);
          const comments = yield* room
            .deleteMessage(principal, threadId, messageId, actor, new Date().toISOString())
            .pipe(Effect.mapError(toApplicationError));
          yield* projectDocument(room);
          yield* scheduleCheckpoint(room);
          return comments as CommentStateDto;
        }),
      deleteThread: (credentials, rawDocumentId, threadId) =>
        Effect.gen(function* () {
          const room = yield* getRoom(rawDocumentId);
          const principal = yield* resolvePrincipal(credentials, rawDocumentId);
          const actor = yield* commentActor(principal, credentials.guestName);
          const comments = yield* room
            .deleteThread(principal, threadId, actor, new Date().toISOString())
            .pipe(Effect.mapError(toApplicationError));
          yield* projectDocument(room);
          yield* scheduleCheckpoint(room);
          return comments as CommentStateDto;
        }),
      editBody: (credentials, rawDocumentId, request) =>
        Effect.gen(function* () {
          const room = yield* getRoom(rawDocumentId);
          const principal = yield* resolvePrincipal(credentials, rawDocumentId);
          yield* room
            .applyTextEdits(
              principal,
              request.edits,
              request.expectedRevision,
              new Date().toISOString(),
            )
            .pipe(Effect.mapError(toApplicationError));
          return yield* afterMutation(room);
        }),
      editMessage: (credentials, rawDocumentId, threadId, messageId, request) =>
        Effect.gen(function* () {
          const room = yield* getRoom(rawDocumentId);
          const principal = yield* resolvePrincipal(credentials, rawDocumentId);
          const actor = yield* commentActor(principal, credentials.guestName);
          const comments = yield* room
            .editMessage(
              principal,
              threadId,
              messageId,
              request.body,
              actor,
              new Date().toISOString(),
            )
            .pipe(Effect.mapError(toApplicationError));
          yield* projectDocument(room);
          yield* scheduleCheckpoint(room);
          return comments as CommentStateDto;
        }),
      listApiKeys: (credentials) =>
        Effect.gen(function* () {
          yield* resolvePrincipal(credentials).pipe(Effect.flatMap(requireOwner));
          return state.authentication.apiKeys.map(apiKeyDto);
        }),
      listDocuments: (credentials, query) =>
        Effect.gen(function* () {
          yield* resolvePrincipal(credentials).pipe(Effect.flatMap(requireOwner));
          const summaries = searchCatalog(state.catalog, query);
          const documents = yield* Effect.forEach(summaries, (summary) =>
            getRoom(summary.documentId).pipe(
              Effect.flatMap((room) => room.snapshot(ownerPrincipal, new Date().toISOString())),
              Effect.mapError(toApplicationError),
              Effect.map((snapshot) => ({
                excerpt: summary.excerpt,
                metadata: snapshot.metadata as DocumentMetadataDto,
              })),
            ),
          );
          return { documents } satisfies CatalogResponse;
        }),
      login: (password) =>
        withState(
          loginOwner(state.authentication, password, new Date().toISOString()).pipe(
            Effect.provideService(SecretHasher, hasher),
            Effect.provideService(SecureToken, tokens),
            Effect.mapError(toApplicationError),
            Effect.flatMap((created) =>
              tokens.generate(24).pipe(
                Effect.mapError(toApplicationError),
                Effect.flatMap((csrfToken) =>
                  saveState({ ...state, authentication: created.state }).pipe(
                    Effect.mapError(toApplicationError),
                    Effect.as({
                      csrfToken,
                      expiresAt: created.expiresAt,
                      sessionToken: created.token,
                    }),
                  ),
                ),
              ),
            ),
          ),
        ),
      logout: (credentials) =>
        credentials.sessionToken === undefined
          ? Effect.void
          : withState(
              saveState({
                ...state,
                authentication: logoutSession(state.authentication, credentials.sessionToken),
              }).pipe(Effect.mapError(toApplicationError)),
            ),
      publish: (credentials, rawDocumentId) =>
        Effect.gen(function* () {
          const room = yield* getRoom(rawDocumentId);
          const principal = yield* resolvePrincipal(credentials, rawDocumentId);
          const metadata = yield* room
            .publish(principal, new Date().toISOString())
            .pipe(Effect.mapError(toApplicationError));
          yield* projectDocument(room);
          yield* scheduleCheckpoint(room);
          return metadata as DocumentMetadataDto;
        }),
      readDocument: (credentials, rawDocumentId, startLine, endLine) =>
        Effect.gen(function* () {
          const room = yield* getRoom(rawDocumentId);
          const principal = yield* resolvePrincipal(credentials, rawDocumentId);
          return yield* snapshotFor(room, principal, startLine, endLine);
        }),
      readPublicRfc: (rfcNumber) =>
        Effect.gen(function* () {
          const entry = state.catalog.entries.find(
            (item) =>
              item.status === "active" &&
              item.rfcNumber === rfcNumber &&
              item.summary?.visibility === "public" &&
              item.summary.publishedRevision !== undefined,
          );
          const summary = entry?.summary;
          const publishedRevision = summary?.publishedRevision;
          if (entry === undefined || summary === undefined || publishedRevision === undefined) {
            return yield* applicationFailure("not_found", "The published RFC does not exist.", 404);
          }
          const snapshot = yield* provideAuthorityDependencies(
            loadDocumentRevision(
              { documentId: entry.documentId, workspaceId: state.workspaceId },
              publishedRevision,
            ),
          ).pipe(Effect.mapError(toApplicationError));
          const rendered = yield* renderer
            .render(snapshot.body, {
              rewriteUrl: rewriteRfcUrl,
            })
            .pipe(Effect.mapError(toApplicationError));
          const room = yield* getRoom(entry.documentId);
          const current = yield* room
            .snapshot(ownerPrincipal, new Date().toISOString())
            .pipe(Effect.mapError(toApplicationError));
          return {
            canonicalPath: `/rfc/${String(rfcNumber).padStart(4, "0")}`,
            description: summary.excerpt,
            headings: rendered.headings,
            html: rendered.html,
            metadata: current.metadata as DocumentMetadataDto,
          } satisfies PublicDocumentResponse;
        }),
      replaceBody: (credentials, rawDocumentId, request) =>
        Effect.gen(function* () {
          const room = yield* getRoom(rawDocumentId);
          const principal = yield* resolvePrincipal(credentials, rawDocumentId);
          yield* room
            .replaceBody(
              principal,
              request.body,
              request.expectedRevision,
              new Date().toISOString(),
            )
            .pipe(Effect.mapError(toApplicationError));
          return yield* afterMutation(room);
        }),
      reply: (credentials, rawDocumentId, threadId, request) =>
        Effect.gen(function* () {
          const room = yield* getRoom(rawDocumentId);
          const principal = yield* resolvePrincipal(credentials, rawDocumentId);
          const actor = yield* commentActor(principal, request.authorDisplayName);
          const messageId = yield* ids.generate("message");
          const comments = yield* room
            .reply(
              principal,
              threadId,
              messageId,
              request.parentId,
              request.body,
              actor,
              new Date().toISOString(),
            )
            .pipe(Effect.mapError(toApplicationError));
          yield* projectDocument(room);
          yield* scheduleCheckpoint(room);
          return comments as CommentStateDto;
        }),
      resolveThread: (credentials, rawDocumentId, threadId, request) =>
        Effect.gen(function* () {
          const room = yield* getRoom(rawDocumentId);
          const principal = yield* resolvePrincipal(credentials, rawDocumentId);
          const comments = yield* room
            .setThreadResolution(principal, threadId, request.resolved, new Date().toISOString())
            .pipe(Effect.mapError(toApplicationError));
          yield* projectDocument(room);
          yield* scheduleCheckpoint(room);
          return comments as CommentStateDto;
        }),
      revokeApiKey: (credentials, keyId) =>
        Effect.gen(function* () {
          yield* resolvePrincipal(credentials).pipe(Effect.flatMap(requireOwner));
          yield* withState(
            revokeApiKey(state.authentication, keyId, new Date().toISOString()).pipe(
              Effect.mapError(toApplicationError),
              Effect.flatMap((authentication) =>
                saveState({ ...state, authentication }).pipe(Effect.mapError(toApplicationError)),
              ),
            ),
          );
        }),
      setupOwner: (password) =>
        withState(
          setupOwner(state.authentication, password).pipe(
            Effect.provideService(SecretHasher, hasher),
            Effect.mapError(toApplicationError),
            Effect.flatMap((authentication) =>
              loginOwner(authentication, password, new Date().toISOString()).pipe(
                Effect.provideService(SecretHasher, hasher),
                Effect.provideService(SecureToken, tokens),
                Effect.mapError(toApplicationError),
              ),
            ),
            Effect.flatMap((created) =>
              tokens.generate(24).pipe(
                Effect.mapError(toApplicationError),
                Effect.flatMap((csrfToken) =>
                  saveState({ ...state, authentication: created.state }).pipe(
                    Effect.mapError(toApplicationError),
                    Effect.as({
                      csrfToken,
                      expiresAt: created.expiresAt,
                      sessionToken: created.token,
                    }),
                  ),
                ),
              ),
            ),
          ),
        ),
      unpublish: (credentials, rawDocumentId) =>
        Effect.gen(function* () {
          const room = yield* getRoom(rawDocumentId);
          const principal = yield* resolvePrincipal(credentials, rawDocumentId);
          const metadata = yield* room
            .unpublish(principal, new Date().toISOString())
            .pipe(Effect.mapError(toApplicationError));
          yield* projectDocument(room);
          yield* scheduleCheckpoint(room);
          return metadata as DocumentMetadataDto;
        }),
      updateMetadata: (credentials, rawDocumentId, request) =>
        Effect.gen(function* () {
          const room = yield* getRoom(rawDocumentId);
          const principal = yield* resolvePrincipal(credentials, rawDocumentId);
          const patch = yield* metadataPatch(request);
          const metadata = yield* room
            .updateMetadata(
              principal,
              patch,
              request.expectedRevision,
              new Date().toISOString(),
              request.confirmConfidentialPublic ?? false,
            )
            .pipe(Effect.mapError(toApplicationError));
          yield* projectDocument(room);
          yield* scheduleCheckpoint(room);
          return metadata as DocumentMetadataDto;
        }),
      updateShare: (credentials, rawDocumentId, request, baseUrl) =>
        Effect.gen(function* () {
          const room = yield* getRoom(rawDocumentId);
          const principal = yield* resolvePrincipal(credentials, rawDocumentId);
          const metadata = yield* room
            .updateSharing(
              principal,
              request.access,
              request.expectedRevision,
              new Date().toISOString(),
              request.expiresAt,
            )
            .pipe(Effect.mapError(toApplicationError));
          const result = yield* withState(
            Effect.gen(function* () {
              const existing = state.capabilities.find(
                (capability) => capability.documentId === room.documentId,
              );
              let capabilityUrl: string | undefined;
              let capability: CapabilityRecord;
              if (existing === undefined) {
                const id = yield* ids.generate("capability");
                const secret = yield* tokens.generate(32).pipe(Effect.mapError(toApplicationError));
                const tokenHash = yield* hasher
                  .hash(secret)
                  .pipe(Effect.mapError(toApplicationError));
                capability = {
                  access: request.access === "disabled" ? "view" : request.access,
                  documentId: room.documentId,
                  expiresAt: request.expiresAt,
                  generation: metadata.sharing.generation,
                  id,
                  tokenHash,
                };
                const capabilityToken = `cap.${room.documentId}.${id}.${secret}`;
                capabilityUrl = `${baseUrl}/share/${room.documentId}?cap=${encodeURIComponent(capabilityToken)}`;
              } else {
                capability = {
                  ...existing,
                  access: request.access === "disabled" ? existing.access : request.access,
                  expiresAt: request.expiresAt,
                  generation: metadata.sharing.generation,
                };
              }
              const capabilities = [
                ...state.capabilities.filter((item) => item.documentId !== room.documentId),
                capability,
              ];
              yield* saveState({ ...state, capabilities }).pipe(
                Effect.mapError(toApplicationError),
              );
              const response: ShareResponse = {
                capabilityUrl,
                policy: metadata.sharing,
              };
              return response;
            }),
          );
          yield* projectDocument(room);
          yield* scheduleCheckpoint(room);
          return result;
        }),
    };

    return service;
  });
}

export function localApplicationLayer(options: LocalApplicationOptions = {}) {
  return Layer.effect(JotApplication, makeLocalJotApplication(options));
}

function loadWorkspaceState(
  store: typeof WorkspaceStateStore.Service,
  workspaceId: string,
): Effect.Effect<LocalWorkspaceState, StorageError> {
  return store.load<unknown>().pipe(
    Effect.flatMap((stored) => {
      if (stored === undefined) {
        return Effect.succeed({
          authentication: emptyAuthenticationState(),
          capabilities: [],
          catalog: emptyWorkspaceCatalog(),
          schemaVersion: 1 as const,
          workspaceId,
        });
      }
      return Schema.decodeUnknown(persistedStateSchema)(stored).pipe(
        Effect.mapError(
          (cause) =>
            new StorageError({
              cause,
              message: "The workspace state has an incompatible schema.",
              operation: "decode workspace state",
              retryable: false,
            }),
        ),
        Effect.map((decoded) => ({
          ...decoded,
          authentication: decoded.authentication as AuthenticationState,
          catalog: decoded.catalog as WorkspaceCatalogState,
        })),
      );
    }),
  );
}

function resolveCapability(
  state: LocalWorkspaceState,
  token: string,
  targetDocumentId: string,
  guestName: string | undefined,
  hasher: typeof SecretHasher.Service,
): Effect.Effect<Principal, ApplicationError> {
  return Effect.gen(function* () {
    const [prefix, documentValue, id, secret, extra] = token.split(".");
    if (
      prefix !== "cap" ||
      documentValue !== targetDocumentId ||
      id === undefined ||
      secret === undefined ||
      extra !== undefined
    ) {
      return yield* applicationFailure("invalid_capability", "The capability is invalid.", 401);
    }
    const record = state.capabilities.find(
      (capability) => capability.documentId === targetDocumentId && capability.id === id,
    );
    if (
      record === undefined ||
      !(yield* hasher.verify(secret, record.tokenHash).pipe(Effect.mapError(toApplicationError)))
    ) {
      return yield* applicationFailure("invalid_capability", "The capability is invalid.", 401);
    }
    if (record.expiresAt !== undefined && Date.parse(record.expiresAt) <= Date.now()) {
      return yield* applicationFailure("invalid_capability", "The capability has expired.", 401);
    }
    const guestId =
      guestName === undefined
        ? undefined
        : yield* personId(`guest_${id}`).pipe(Effect.mapError(toApplicationError));
    return {
      access: record.access,
      documentId: targetDocumentId,
      generation: record.generation,
      guestId,
      kind: "capability",
    };
  });
}

function allowedActions(
  principal: Principal,
  metadata: DocumentMetadata,
  now: string,
): readonly string[] {
  return documentActions.filter((action) =>
    isDocumentActionAllowed(principal, action, metadata, now),
  );
}

function summaryFromSnapshot(snapshot: DocumentSnapshot): CatalogSummary {
  const body = normalizeSearchText(snapshot.body);
  return {
    approvers: snapshot.metadata.approvers,
    authors: snapshot.metadata.authors,
    documentId: snapshot.metadata.id,
    excerpt: excerpt(snapshot.body),
    labels: snapshot.metadata.labels,
    normalizedBody: body,
    publishedRevision: snapshot.metadata.publishedRevision,
    revision: snapshot.metadata.headRevision,
    reviewers: snapshot.metadata.reviewers,
    rfcNumber: snapshot.metadata.rfcNumber,
    sensitivity: snapshot.metadata.sensitivity,
    state: snapshot.metadata.lifecycleState,
    title: snapshot.metadata.title,
    updatedAt: snapshot.metadata.updatedAt,
    visibility: snapshot.metadata.visibility,
  };
}

function excerpt(body: string): string {
  return body
    .replace(/```[\s\S]*?```/gu, " ")
    .replace(/[^\p{Letter}\p{Number}\s]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 240);
}

function toDocumentResponse(snapshot: DocumentSnapshot): DocumentResponse {
  return {
    body: snapshot.body,
    comments: snapshot.comments as CommentStateDto,
    metadata: snapshot.metadata as DocumentMetadataDto,
    sequence: snapshot.sequence,
  };
}

function apiKeyDto(record: ApiKeyRecord): ApiKeyDto {
  return {
    createdAt: record.createdAt,
    id: record.id,
    label: record.label,
    lastUsedAt: record.lastUsedAt,
    revokedAt: record.revokedAt,
  };
}

function requireOwner(principal: Principal): Effect.Effect<void, ApplicationError> {
  return (principal.kind === "workspace" || principal.kind === "api-key") &&
    (principal.role === "owner" || principal.role === "administrator")
    ? Effect.void
    : applicationFailure("forbidden", "Workspace owner access is required.", 403);
}

function metadataPatch(
  request: MetadataPatchRequest,
): Effect.Effect<MetadataPatch, ApplicationError> {
  return Effect.gen(function* () {
    return {
      approvers: yield* convertPeople(request.approvers),
      authors: yield* convertPeople(request.authors),
      labels: request.labels,
      legacySourceUrl: request.legacySourceUrl,
      lifecycleState: request.lifecycleState,
      relatedDocuments: yield* convertRelated(request.relatedDocuments),
      reviewers: yield* convertPeople(request.reviewers),
      sensitivity: request.sensitivity,
      targetDecisionDate: request.targetDecisionDate,
      title: request.title,
      visibility: request.visibility,
    };
  });
}

function convertPeople(
  people:
    | readonly { readonly displayName: string; readonly email: string; readonly id: string }[]
    | undefined,
): Effect.Effect<readonly PersonReference[] | undefined, ApplicationError> {
  return people === undefined
    ? Effect.succeed(undefined)
    : Effect.forEach(people, (person) =>
        personId(person.id).pipe(
          Effect.mapError(toApplicationError),
          Effect.map((id) => ({ ...person, id })),
        ),
      );
}

function convertRelated(
  related:
    | readonly { readonly documentId: string; readonly relationship?: string | undefined }[]
    | undefined,
): Effect.Effect<readonly RelatedDocumentReference[] | undefined, ApplicationError> {
  return related === undefined
    ? Effect.succeed(undefined)
    : Effect.forEach(related, (item) =>
        documentId(item.documentId).pipe(
          Effect.mapError(toApplicationError),
          Effect.map((id) => ({ documentId: id, relationship: item.relationship })),
        ),
      );
}

function rewriteRfcUrl(url: string): string | undefined {
  const match = /(?:^|\/)rfc[-_/]?(\d+)(?:\.md)?(?:#(.*))?$/iu.exec(url);
  return match?.[1] === undefined
    ? url
    : `/rfc/${match[1].padStart(4, "0")}${match[2] === undefined ? "" : `#${match[2]}`}`;
}

function toApplicationError(error: unknown): ApplicationError {
  if (error instanceof ApplicationError) {
    return error;
  }
  if (error instanceof AuthenticationError) {
    return new ApplicationError({
      cause: error,
      code: error.code,
      message: error.message,
      retryable: false,
      status: error.code === "already_initialized" ? 409 : 401,
    });
  }
  if (error instanceof AuthorizationError) {
    return new ApplicationError({
      cause: error,
      code: "forbidden",
      message: error.message,
      retryable: false,
      status: 403,
    });
  }
  if (error instanceof BodyEditError) {
    return new ApplicationError({
      cause: error,
      code: error.code,
      message: error.message,
      retryable: false,
      status: 409,
    });
  }
  if (error instanceof DomainError) {
    return new ApplicationError({
      cause: error,
      code: error.code,
      message: error.message,
      retryable: false,
      status: error.code === "revision_conflict" ? 409 : 400,
    });
  }
  if (error instanceof StorageError) {
    return new ApplicationError({
      cause: error,
      code: "storage_error",
      message: error.message,
      retryable: error.retryable,
      status: error.retryable ? 503 : 500,
    });
  }
  if (error instanceof RecoveryError || error instanceof CollaborationError) {
    return new ApplicationError({
      cause: error,
      code: error.code,
      message: error.message,
      retryable: false,
      status: 500,
    });
  }
  return new ApplicationError({
    cause: error,
    code: "internal_error",
    message: "An unexpected application error occurred.",
    retryable: false,
    status: 500,
  });
}

function toStorageError(error: unknown): StorageError {
  return error instanceof StorageError
    ? error
    : new StorageError({
        cause: error,
        message: "Local application initialization failed.",
        operation: "initialize application",
        retryable: false,
      });
}

function applicationFailure(
  code: string,
  message: string,
  status: ApplicationError["status"],
): Effect.Effect<never, ApplicationError> {
  return Effect.fail(new ApplicationError({ code, message, retryable: false, status }));
}
