import { Effect, Fiber, Layer, Schema, Stream } from "effect";

import {
  activateDocument,
  applyCatalogSummary,
  authenticateApiKey,
  authorizeDocument,
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
  publicCatalog,
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
  decodeBase64,
  encodeBase64,
  loadDocumentRevision,
  makeDocumentAuthority,
  RecoveryError,
} from "@earendil-works/jot-collaboration";
import type { DocumentAuthorityService, DocumentSnapshot } from "@earendil-works/jot-collaboration";
import { ApplicationError, JotApplication } from "./application.ts";
import type {
  CollaborationConnection,
  JotApplicationService,
  RequestCredentials,
} from "./application.ts";
import type {
  ApiKeyCreated,
  ApiKeyDto,
  AttachmentMetadataDto,
  CatalogResponse,
  CommentStateDto,
  DocumentMetadataDto,
  DocumentResponse,
  ImportDocumentRequest,
  MetadataPatchRequest,
  PublicDocumentResponse,
  ServerCollaborationMessage,
  ShareResponse,
} from "@earendil-works/jot-protocol";
import { MarkdownRenderer } from "@earendil-works/jot-renderer";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

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
  readonly attachments: Readonly<Record<string, readonly AttachmentMetadataDto[]>>;
  readonly capabilities: readonly CapabilityRecord[];
}

const backupArchiveSchema = Schema.Struct({
  createdAt: Schema.String,
  objects: Schema.Array(
    Schema.Struct({
      bytes: Schema.String,
      digest: Schema.String,
      key: Schema.String,
      mediaType: Schema.optional(Schema.String),
    }),
  ),
  schemaVersion: Schema.Literal(1),
  workspaceState: Schema.Unknown,
});

const persistedStateSchema = Schema.Struct({
  authentication: Schema.Unknown,
  attachments: Schema.optional(
    Schema.Record({ key: Schema.String, value: Schema.Array(Schema.Unknown) }),
  ),
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
      exportWorkspace: (credentials) =>
        Effect.gen(function* () {
          const principal = yield* resolvePrincipal(credentials);
          yield* requireOwner(principal);
          yield* Effect.forEach(rooms.values(), (room) =>
            room.checkpoint(new Date().toISOString()).pipe(Effect.mapError(toApplicationError)),
          );
          const keys = yield* objectStore.list("").pipe(Effect.mapError(toApplicationError));
          const objects = yield* Effect.forEach(keys, (key) =>
            objectStore.get(key).pipe(
              Effect.mapError(toApplicationError),
              Effect.flatMap((stored) =>
                stored === undefined
                  ? applicationFailure(
                      "backup_race",
                      `Object disappeared during backup: ${key}`,
                      503,
                      true,
                    )
                  : Effect.succeed({
                      bytes: encodeBase64(stored.bytes),
                      digest: stored.digest,
                      key,
                      mediaType: stored.mediaType,
                    }),
              ),
            ),
          );
          const createdAt = new Date().toISOString();
          const manifestBytes = textEncoder.encode(
            JSON.stringify({
              createdAt,
              objects: objects.map((object) => ({
                digest: object.digest,
                key: object.key,
                size: object.bytes.length,
              })),
              schemaVersion: 1,
              workspaceId: state.workspaceId,
            }),
          );
          const manifestDigest = yield* digest
            .sha256(manifestBytes)
            .pipe(Effect.mapError(toApplicationError));
          yield* objectStore
            .put(
              `workspaces/${state.workspaceId}/backups/${createdAt.replaceAll(":", "-")}.manifest.json`,
              manifestBytes,
              { digest: manifestDigest, mediaType: "application/json" },
            )
            .pipe(Effect.mapError(toApplicationError));
          return textEncoder.encode(
            JSON.stringify({
              createdAt,
              objects,
              schemaVersion: 1,
              workspaceState: state,
            }),
          );
        }),
      restoreWorkspace: (credentials, archive) =>
        Effect.gen(function* () {
          const principal = yield* resolvePrincipal(credentials);
          yield* requireOwner(principal);
          if (archive.byteLength === 0 || archive.byteLength > 250_000_000) {
            return yield* applicationFailure(
              "backup_size",
              "Backup archives must be between 1 byte and 250 MB.",
              413,
            );
          }
          const decoded = yield* Schema.decodeUnknown(Schema.parseJson(backupArchiveSchema))(
            textDecoder.decode(archive),
          ).pipe(
            Effect.mapError(
              (cause) =>
                new ApplicationError({
                  cause,
                  code: "invalid_backup",
                  message: "The backup archive is invalid or incompatible.",
                  retryable: false,
                  status: 400,
                }),
            ),
          );
          const decodedState = yield* Schema.decodeUnknown(persistedStateSchema)(
            decoded.workspaceState,
          ).pipe(
            Effect.mapError(
              (cause) =>
                new ApplicationError({
                  cause,
                  code: "invalid_backup_state",
                  message: "The backup workspace state is invalid.",
                  retryable: false,
                  status: 400,
                }),
            ),
          );
          const objects = yield* Effect.forEach(decoded.objects, (object) =>
            Effect.gen(function* () {
              if (!validBackupObjectKey(object.key)) {
                return yield* applicationFailure(
                  "invalid_backup_key",
                  `Backup object key is unsafe: ${object.key}`,
                  400,
                );
              }
              const bytes = yield* decodeBase64(object.bytes).pipe(
                Effect.mapError(
                  (cause) =>
                    new ApplicationError({
                      cause,
                      code: "invalid_backup_object",
                      message: `Backup object ${object.key} is not valid base64.`,
                      retryable: false,
                      status: 400,
                    }),
                ),
              );
              const actual = yield* digest.sha256(bytes).pipe(Effect.mapError(toApplicationError));
              if (actual !== object.digest) {
                return yield* applicationFailure(
                  "backup_digest_mismatch",
                  `Backup object ${object.key} failed digest verification.`,
                  400,
                );
              }
              return { ...object, bytes };
            }),
          );
          yield* Effect.forEach(objects, (object) =>
            objectStore
              .put(object.key, object.bytes, {
                digest: object.digest,
                mediaType: object.mediaType,
              })
              .pipe(Effect.mapError(toApplicationError)),
          );
          yield* Effect.forEach(rooms.values(), (room) => room.close);
          rooms.clear();
          const restored: LocalWorkspaceState = {
            ...decodedState,
            authentication: decodedState.authentication as AuthenticationState,
            attachments: Object.fromEntries(
              Object.entries(decodedState.attachments ?? {}).map(([documentKey, attachments]) => [
                documentKey,
                attachments as unknown as readonly AttachmentMetadataDto[],
              ]),
            ),
            catalog: decodedState.catalog as WorkspaceCatalogState,
          };
          yield* saveState(restored).pipe(Effect.mapError(toApplicationError));
          return { checkedObjects: objects.length, errors: [] };
        }),
      verifyWorkspace: (credentials) =>
        Effect.gen(function* () {
          const principal = yield* resolvePrincipal(credentials);
          yield* requireOwner(principal);
          const keys = yield* objectStore.list("").pipe(Effect.mapError(toApplicationError));
          const errors = yield* Effect.forEach(keys, (key) =>
            objectStore.get(key).pipe(
              Effect.mapError(toApplicationError),
              Effect.flatMap((stored) => {
                if (stored === undefined) return Effect.succeed(`Missing object: ${key}`);
                return digest.sha256(stored.bytes).pipe(
                  Effect.mapError(toApplicationError),
                  Effect.map((actual) =>
                    actual === stored.digest ? undefined : `Digest mismatch: ${key}`,
                  ),
                );
              }),
            ),
          );
          return {
            checkedObjects: keys.length,
            errors: errors.filter((error): error is string => error !== undefined),
          };
        }),
      uploadAttachment: (credentials, rawDocumentId, filename, mediaType, bytes) =>
        Effect.gen(function* () {
          if (bytes.byteLength === 0 || bytes.byteLength > 10_000_000) {
            return yield* applicationFailure(
              "attachment_size",
              "Attachments must be between 1 byte and 10 MB.",
              413,
            );
          }
          if (!allowedAttachmentTypes.has(mediaType)) {
            return yield* applicationFailure(
              "attachment_type",
              "This attachment media type is not allowed.",
              400,
            );
          }
          const normalizedFilename = filename.trim();
          if (normalizedFilename.length === 0 || normalizedFilename.length > 240) {
            return yield* applicationFailure(
              "attachment_filename",
              "Attachment filenames must be between 1 and 240 characters.",
              400,
            );
          }
          const room = yield* getRoom(rawDocumentId);
          const principal = yield* resolvePrincipal(credentials, rawDocumentId);
          const now = new Date().toISOString();
          const snapshot = yield* room
            .snapshot(principal, now)
            .pipe(Effect.mapError(toApplicationError));
          yield* authorizeDocument(principal, "edit-body", snapshot.metadata, now).pipe(
            Effect.mapError(toApplicationError),
          );
          const attachmentId = yield* ids.generate("attachment");
          const contentDigest = yield* digest
            .sha256(bytes)
            .pipe(Effect.mapError(toApplicationError));
          const metadata: AttachmentMetadataDto = {
            createdAt: now,
            digest: contentDigest,
            filename: normalizedFilename,
            id: attachmentId,
            mediaType,
            size: bytes.byteLength,
            uploaderId:
              principal.kind === "workspace" || principal.kind === "api-key"
                ? principal.personId
                : principal.kind === "capability"
                  ? (principal.guestId ?? ownerId)
                  : ownerId,
            url: `/api/documents/${encodeURIComponent(room.documentId)}/attachments/${encodeURIComponent(attachmentId)}`,
          };
          yield* objectStore
            .put(attachmentObjectKey(state.workspaceId, room.documentId, attachmentId), bytes, {
              digest: contentDigest,
              mediaType,
            })
            .pipe(Effect.mapError(toApplicationError));
          yield* withState(
            saveState({
              ...state,
              attachments: {
                ...state.attachments,
                [room.documentId]: [...(state.attachments[room.documentId] ?? []), metadata],
              },
            }).pipe(Effect.mapError(toApplicationError)),
          );
          return metadata;
        }),
      listAttachments: (credentials, rawDocumentId) =>
        Effect.gen(function* () {
          const room = yield* getRoom(rawDocumentId);
          const principal = yield* resolvePrincipal(credentials, rawDocumentId);
          yield* room
            .snapshot(principal, new Date().toISOString())
            .pipe(Effect.mapError(toApplicationError), Effect.asVoid);
          return state.attachments[room.documentId] ?? [];
        }),
      readAttachment: (credentials, rawDocumentId, attachmentId) =>
        Effect.gen(function* () {
          const room = yield* getRoom(rawDocumentId);
          const principal = yield* resolvePrincipal(credentials, rawDocumentId);
          yield* room
            .snapshot(principal, new Date().toISOString())
            .pipe(Effect.mapError(toApplicationError), Effect.asVoid);
          const metadata = state.attachments[room.documentId]?.find(
            (attachment) => attachment.id === attachmentId,
          );
          if (metadata === undefined) {
            return yield* applicationFailure("not_found", "The attachment does not exist.", 404);
          }
          const stored = yield* objectStore
            .get(attachmentObjectKey(state.workspaceId, room.documentId, attachmentId))
            .pipe(Effect.mapError(toApplicationError));
          if (stored === undefined || stored.digest !== metadata.digest) {
            return yield* applicationFailure(
              "attachment_unavailable",
              "The attachment content is unavailable or corrupt.",
              503,
              true,
            );
          }
          return { bytes: stored.bytes, metadata };
        }),
      checkpointAll: () =>
        Effect.forEach(rooms.values(), (room) =>
          room.checkpoint(new Date().toISOString()).pipe(Effect.mapError(toApplicationError)),
        ).pipe(Effect.asVoid),
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
                  Effect.map((accepted): ServerCollaborationMessage => ({
                    clientUpdateId: accepted.clientUpdateId,
                    documentRevision: accepted.revision,
                    serverSequence: accepted.sequence,
                    type: "update-accepted",
                    update: encodeBase64(accepted.update),
                  })),
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
      importDocument: (credentials, request: ImportDocumentRequest) =>
        Effect.gen(function* () {
          const principal = yield* resolvePrincipal(credentials);
          yield* requireOwner(principal);
          const generatedId = yield* ids.generate("doc");
          const importedId = request.metadata.id ?? generatedId;
          const reservation = yield* withState(
            reserveDocument(state.catalog, {
              allocateRfc: false,
              creationKey: `import:${importedId}`,
              documentId: importedId,
              requestedRfcNumber: request.metadata.rfcNumber,
            }).pipe(
              Effect.mapError(toApplicationError),
              Effect.tap(({ state: catalog }) =>
                saveState({ ...state, catalog }).pipe(Effect.mapError(toApplicationError)),
              ),
            ),
          );
          if (reservation.entry.status === "active") {
            const existing = yield* getRoom(reservation.entry.documentId);
            return yield* snapshotFor(existing, ownerPrincipal);
          }
          const importedAt = request.metadata.updatedAt ?? new Date().toISOString();
          const metadata = yield* createDocumentMetadata(
            {
              approvers: yield* convertPeople(request.metadata.approvers),
              authors: yield* convertPeople(request.metadata.authors),
              createdAt: request.metadata.createdAt,
              id: reservation.entry.documentId,
              labels: request.metadata.labels,
              legacySourceUrl: request.metadata.legacySourceUrl,
              lifecycleState: request.metadata.lifecycleState,
              relatedDocuments: yield* convertRelated(request.metadata.relatedDocuments),
              reviewers: yield* convertPeople(request.metadata.reviewers),
              rfcNumber: reservation.entry.rfcNumber,
              sensitivity: request.metadata.sensitivity,
              targetDecisionDate: request.metadata.targetDecisionDate,
              title: request.metadata.title,
              visibility: request.metadata.visibility,
            },
            importedAt,
          ).pipe(Effect.mapError(toApplicationError));
          const room = yield* provideAuthorityDependencies(
            makeDocumentAuthority({
              documentId: reservation.entry.documentId,
              initialBody: request.body,
              initialMetadata: metadata,
              workspaceId: state.workspaceId,
            }),
          ).pipe(Effect.mapError(toApplicationError));
          rooms.set(room.documentId, room);
          for (const importedThread of request.comments ?? []) {
            const range = importedCommentRange(request.body, importedThread);
            if (range === undefined) continue;
            const root = importedThread.messages[0];
            if (root === undefined) continue;
            const threadId = yield* ids.generate("thread");
            const rootId = yield* ids.generate("message");
            const actor: CommentActor = {
              displayName: root.authorDisplayName,
              id: ownerId,
              manageAll: true,
            };
            yield* room
              .createThreadAtOffsets(
                ownerPrincipal,
                {
                  body: root.body,
                  end: range.end,
                  id: threadId,
                  messageId: rootId,
                  start: range.start,
                },
                actor,
                root.createdAt ?? importedAt,
              )
              .pipe(Effect.mapError(toApplicationError));
            const messageIds = new Map<string, string>();
            if (root.legacyId !== undefined) messageIds.set(root.legacyId, rootId);
            let lastMessageId = rootId;
            for (const importedMessage of importedThread.messages.slice(1)) {
              const messageId = yield* ids.generate("message");
              const parentId =
                (importedMessage.parentLegacyId === undefined
                  ? undefined
                  : messageIds.get(importedMessage.parentLegacyId)) ?? lastMessageId;
              yield* room
                .reply(
                  ownerPrincipal,
                  threadId,
                  messageId,
                  parentId,
                  importedMessage.body,
                  {
                    displayName: importedMessage.authorDisplayName,
                    id: ownerId,
                    manageAll: true,
                  },
                  importedMessage.createdAt ?? importedAt,
                )
                .pipe(Effect.mapError(toApplicationError));
              if (importedMessage.legacyId !== undefined) {
                messageIds.set(importedMessage.legacyId, messageId);
              }
              lastMessageId = messageId;
            }
            if (importedThread.resolved) {
              yield* room
                .setThreadResolution(ownerPrincipal, threadId, true, importedAt)
                .pipe(Effect.mapError(toApplicationError));
            }
          }
          yield* room.checkpoint(importedAt).pipe(Effect.mapError(toApplicationError));
          if (request.publish === true) {
            yield* room
              .publish(ownerPrincipal, importedAt)
              .pipe(Effect.mapError(toApplicationError));
            const published = yield* room
              .snapshot(ownerPrincipal, importedAt)
              .pipe(Effect.mapError(toApplicationError));
            yield* writePublishedArtifact(
              state.workspaceId,
              published,
              renderer,
              objectStore,
              digest,
            ).pipe(Effect.ignore);
            yield* room.checkpoint(importedAt).pipe(Effect.mapError(toApplicationError));
          }
          const snapshot = yield* room
            .snapshot(ownerPrincipal, importedAt)
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
      listPublicDocuments: (query, lifecycleState, label) =>
        Effect.gen(function* () {
          const normalizedQuery = normalizeSearchText(query);
          const entries = publicCatalog(state.catalog).filter(
            (summary) =>
              (normalizedQuery.length === 0 ||
                normalizeSearchText(
                  `${summary.rfcNumber ?? ""} ${summary.title} ${summary.normalizedBody} ${summary.labels.join(" ")}`,
                ).includes(normalizedQuery)) &&
              (lifecycleState === undefined || summary.state === lifecycleState) &&
              (label === undefined || summary.labels.includes(label)),
          );
          const documents = yield* Effect.forEach(entries, (summary) => {
            const publishedRevision = summary.publishedRevision;
            if (publishedRevision === undefined) return Effect.succeed(undefined);
            return provideAuthorityDependencies(
              loadDocumentRevision(
                { documentId: summary.documentId, workspaceId: state.workspaceId },
                publishedRevision,
              ),
            ).pipe(
              Effect.mapError(toApplicationError),
              Effect.map((snapshot) => ({
                excerpt: excerpt(snapshot.body),
                metadata: snapshot.metadata as DocumentMetadataDto,
              })),
            );
          });
          return {
            documents: documents.filter(
              (document): document is Exclude<typeof document, undefined> => document !== undefined,
            ),
          } satisfies CatalogResponse;
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
          const published = yield* room
            .snapshot(ownerPrincipal, new Date().toISOString())
            .pipe(Effect.mapError(toApplicationError));
          yield* writePublishedArtifact(
            state.workspaceId,
            published,
            renderer,
            objectStore,
            digest,
          ).pipe(Effect.ignore);
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
          attachments: {},
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
          attachments: Object.fromEntries(
            Object.entries(decoded.attachments ?? {}).map(([documentKey, attachments]) => [
              documentKey,
              attachments as unknown as readonly AttachmentMetadataDto[],
            ]),
          ),
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

function importedCommentRange(
  body: string,
  thread: NonNullable<ImportDocumentRequest["comments"]>[number],
): { readonly start: number; readonly end: number } | undefined {
  const start = thread.originalStart;
  const end = thread.originalEnd;
  if (
    start !== undefined &&
    end !== undefined &&
    start <= end &&
    end <= body.length &&
    (thread.quote.length === 0 || body.slice(start, end) === thread.quote)
  ) {
    return { end, start };
  }
  if (thread.quote.length === 0) return undefined;
  const first = body.indexOf(thread.quote);
  if (first === -1 || body.indexOf(thread.quote, first + 1) !== -1) return undefined;
  return { end: first + thread.quote.length, start: first };
}

function writePublishedArtifact(
  workspaceId: string,
  snapshot: DocumentSnapshot,
  renderer: typeof MarkdownRenderer.Service,
  objectStore: typeof ObjectStore.Service,
  digest: typeof Digest.Service,
): Effect.Effect<void, StorageError> {
  return Effect.gen(function* () {
    const revision = snapshot.metadata.publishedRevision;
    if (revision === undefined) return;
    const rendered = yield* renderer.render(snapshot.body, { rewriteUrl: rewriteRfcUrl }).pipe(
      Effect.mapError(
        (cause) =>
          new StorageError({
            cause,
            message: "The published Markdown could not be rendered.",
            operation: "render published artifact",
            retryable: true,
          }),
      ),
    );
    const title = escapeMarkup(snapshot.metadata.title);
    const description = escapeMarkup(excerpt(snapshot.body));
    const canonical =
      snapshot.metadata.rfcNumber === undefined
        ? `/documents/${snapshot.metadata.id}`
        : `/rfc/${String(snapshot.metadata.rfcNumber).padStart(4, "0")}`;
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><meta name="description" content="${description}"><meta property="og:title" content="${title}"><meta property="og:description" content="${description}"><link rel="canonical" href="${canonical}"></head><body><main><h1>${title}</h1>${rendered.html}</main></body></html>`;
    const bytes = new TextEncoder().encode(html);
    const contentDigest = yield* digest.sha256(bytes);
    yield* objectStore.put(
      `workspaces/${workspaceId}/documents/${snapshot.metadata.id}/published/${revision}.html`,
      bytes,
      { digest: contentDigest, mediaType: "text/html; charset=utf-8" },
    );
  });
}

function validBackupObjectKey(key: string): boolean {
  return (
    key.length > 0 &&
    key.length <= 1_024 &&
    !key.startsWith("/") &&
    !key.includes("\\") &&
    key.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
  );
}

function escapeMarkup(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

const allowedAttachmentTypes = new Set([
  "application/pdf",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/svg+xml",
  "image/webp",
  "text/plain",
]);

function attachmentObjectKey(
  workspaceId: string,
  documentKey: string,
  attachmentId: string,
): string {
  return `workspaces/${workspaceId}/documents/${documentKey}/attachments/${attachmentId}`;
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
  retryable = false,
): Effect.Effect<never, ApplicationError> {
  return Effect.fail(new ApplicationError({ code, message, retryable, status }));
}
