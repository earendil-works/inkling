import { Effect, Either, Fiber, Layer, Schema, Stream } from "effect";

import {
  activateDocument,
  applyCatalogSummary,
  authenticateApiKey,
  authorizeDocument,
  authorizeWorkspace,
  authenticateSession,
  AuthenticationError,
  AuthorizationError,
  BodyEditError,
  createApiKey,
  createDocumentMetadata,
  createWorkspaceSession,
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
  upsertPerson,
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
  DocumentRevision,
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
  DocumentRuntimeConfiguration,
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

const privateDocumentStateSchema = Schema.Struct({
  attachments: Schema.Array(Schema.Unknown),
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
  schemaVersion: Schema.Literal(1),
});

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
  readonly allowOwnerSetup?: boolean | undefined;
  readonly authenticationMethods?: readonly ("password" | "google")[] | undefined;
  readonly workspaceId?: string | undefined;
  readonly ownsDocumentPrivateState?: boolean | undefined;
  readonly principalResolver?:
    | ((
        credentials: RequestCredentials,
        documentId?: string,
      ) => Effect.Effect<Principal, ApplicationError>)
    | undefined;
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
    state = yield* hydratePrivateDocumentState(state, objectStore);
    const ownerId = yield* personId("owner@local").pipe(Effect.mapError(toStorageError));
    const ownerPrincipal: Principal = { kind: "workspace", personId: ownerId, role: "owner" };

    const saveState = (next: LocalWorkspaceState): Effect.Effect<void, StorageError> =>
      stateStore.save(next).pipe(
        Effect.tap(() => persistCatalogProjections(next, objectStore, digest).pipe(Effect.ignore)),
        Effect.tap(() => Effect.sync(() => (state = next))),
      );

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

    const resolveStoredPrincipal = (
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

    const resolvePrincipal = (
      credentials: RequestCredentials,
      targetDocumentId?: string,
    ): Effect.Effect<Principal, ApplicationError> => {
      if (credentials.internalPrincipal !== undefined) {
        return Effect.succeed(credentials.internalPrincipal);
      }
      if (options.principalResolver === undefined || credentials.capabilityToken !== undefined) {
        return resolveStoredPrincipal(credentials, targetDocumentId);
      }
      return options.principalResolver(credentials, targetDocumentId);
    };

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

    const runtimeConfiguration = (
      rawDocumentId: string,
    ): Effect.Effect<DocumentRuntimeConfiguration, ApplicationError> =>
      Effect.gen(function* () {
        const id = yield* documentId(rawDocumentId).pipe(Effect.mapError(toApplicationError));
        const entry = state.catalog.entries.find(
          (candidate) => candidate.documentId === id && candidate.status === "active",
        );
        if (entry === undefined) {
          return yield* applicationFailure("not_found", "The document does not exist.", 404);
        }
        return {
          capabilities: state.capabilities.filter((capability) => capability.documentId === id),
          documentId: id,
          rfcNumber: entry.rfcNumber,
          summary: entry.summary,
          workspaceId: state.workspaceId,
        };
      });

    const readPublished = (
      rawDocumentId: string,
      canonicalPath: string,
    ): Effect.Effect<PublicDocumentResponse, ApplicationError> =>
      Effect.gen(function* () {
        const room = yield* getRoom(rawDocumentId);
        const current = yield* room
          .snapshot(ownerPrincipal, new Date().toISOString())
          .pipe(Effect.mapError(toApplicationError));
        const publishedRevision = current.metadata.publishedRevision;
        if (current.metadata.visibility !== "public" || publishedRevision === undefined) {
          return yield* applicationFailure(
            "not_found",
            "The published document does not exist.",
            404,
          );
        }
        const published = yield* provideAuthorityDependencies(
          loadDocumentRevision(
            { documentId: current.metadata.id, workspaceId: state.workspaceId },
            publishedRevision,
          ),
        ).pipe(Effect.mapError(toApplicationError));
        const rendered = yield* renderer
          .render(published.body, { rewriteUrl: rewriteRfcUrl })
          .pipe(Effect.mapError(toApplicationError));
        return {
          canonicalPath,
          description: excerpt(published.body),
          headings: rendered.headings,
          html: rendered.html,
          metadata: {
            ...published.metadata,
            publishedRevision,
          } as DocumentMetadataDto,
        };
      });

    const service: JotApplicationService = {
      authorizeRequest: resolvePrincipal,
      documentRuntimeConfiguration: runtimeConfiguration,
      allDocumentRuntimeConfigurations: () =>
        Effect.forEach(
          state.catalog.entries.filter((entry) => entry.status === "active"),
          (entry) => runtimeConfiguration(entry.documentId),
        ),
      currentDocumentProjection: (rawDocumentId) =>
        getRoom(rawDocumentId).pipe(Effect.flatMap((room) => snapshotFor(room, ownerPrincipal))),
      applyDocumentProjection: (document) =>
        withState(
          applyCatalogSummary(state.catalog, summaryFromDocument(document)).pipe(
            Effect.mapError(toApplicationError),
            Effect.flatMap((catalog) =>
              saveState({ ...state, catalog }).pipe(Effect.mapError(toApplicationError)),
            ),
          ),
        ),
      releaseDocumentRoom: (rawDocumentId) =>
        Effect.gen(function* () {
          const room = rooms.get(rawDocumentId);
          const checkpointFiber = checkpointFibers.get(rawDocumentId);
          if (checkpointFiber !== undefined) yield* Fiber.interrupt(checkpointFiber);
          if (room !== undefined) yield* room.close;
          checkpointFibers.delete(rawDocumentId);
          dirtySince.delete(rawDocumentId);
          rooms.delete(rawDocumentId);
        }),
      markCatalogDeleted: (rawDocumentId) =>
        Effect.gen(function* () {
          const id = yield* documentId(rawDocumentId).pipe(Effect.mapError(toApplicationError));
          yield* withState(
            tombstoneDocument(state.catalog, id).pipe(
              Effect.mapError(toApplicationError),
              Effect.flatMap((catalog) =>
                saveState({ ...state, catalog }).pipe(Effect.mapError(toApplicationError)),
              ),
            ),
          );
        }),
      diagnostics: (credentials) =>
        Effect.gen(function* () {
          const principal = yield* resolvePrincipal(credentials);
          yield* requireOwner(principal);
          return {
            activeDocumentRooms: rooms.size,
            dirtyDocuments: checkpointFibers.size,
            generatedAt: new Date().toISOString(),
          };
        }),
      exportWorkspace: (credentials) =>
        Effect.gen(function* () {
          const principal = yield* resolvePrincipal(credentials);
          yield* requireOwner(principal);
          yield* Effect.forEach(rooms.values(), (room) =>
            room.checkpoint(new Date().toISOString()).pipe(Effect.mapError(toApplicationError)),
          );
          if (options.ownsDocumentPrivateState !== false) {
            yield* Effect.forEach(
              state.catalog.entries.filter((entry) => entry.status === "active"),
              (entry) =>
                persistPrivateDocumentState(state, entry.documentId, objectStore, digest).pipe(
                  Effect.mapError(toApplicationError),
                ),
            );
          }
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
      repairCatalog: (credentials) =>
        Effect.gen(function* () {
          const principal = yield* resolvePrincipal(credentials);
          yield* requireOwner(principal);
          const prefix = `workspaces/${state.workspaceId}/documents/`;
          const keys = yield* objectStore.list(prefix).pipe(Effect.mapError(toApplicationError));
          const documentIds = [
            ...new Set(
              keys.flatMap((key) => {
                const match = /^workspaces\/[^/]+\/documents\/([^/]+)\/head\.json$/u.exec(key);
                return match?.[1] === undefined ? [] : [match[1]];
              }),
            ),
          ].toSorted();
          const deletedEntries = state.catalog.entries.filter(
            (entry) => entry.status === "deleted",
          );
          let rebuilt: WorkspaceCatalogState = {
            entries: deletedEntries,
            nextRfcNumber: Math.max(
              1,
              ...deletedEntries.map((entry) => (entry.rfcNumber ?? 0) + 1),
            ),
            people: state.catalog.people,
          };
          const errors: string[] = [];
          for (const rawDocumentId of documentIds) {
            if (deletedEntries.some((entry) => entry.documentId === rawDocumentId)) continue;
            const recovered = yield* provideAuthorityDependencies(
              makeDocumentAuthority({
                documentId: yield* documentId(rawDocumentId).pipe(
                  Effect.mapError(toApplicationError),
                ),
                workspaceId: state.workspaceId,
              }),
            ).pipe(
              Effect.flatMap((room) =>
                room
                  .snapshot(ownerPrincipal, new Date().toISOString())
                  .pipe(Effect.map((snapshot) => ({ room, snapshot }))),
              ),
              Effect.mapError(toApplicationError),
              Effect.either,
            );
            if (Either.isLeft(recovered)) {
              errors.push(`${rawDocumentId}: ${recovered.left.message}`);
              continue;
            }
            const { room, snapshot } = recovered.right;
            const reserved = yield* reserveDocument(rebuilt, {
              allocateRfc: false,
              creationKey: `repair:${rawDocumentId}`,
              documentId: rawDocumentId,
              requestedRfcNumber: snapshot.metadata.rfcNumber,
            }).pipe(Effect.mapError(toApplicationError));
            rebuilt = yield* activateDocument(reserved.state, room.documentId).pipe(
              Effect.flatMap((catalog) =>
                applyCatalogSummary(catalog, summaryFromSnapshot(snapshot)),
              ),
              Effect.mapError(toApplicationError),
            );
            rooms.set(room.documentId, room);
          }
          if (errors.length === 0) {
            yield* saveState({ ...state, catalog: rebuilt }).pipe(
              Effect.mapError(toApplicationError),
            );
          }
          return { checkedObjects: documentIds.length, errors };
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
          const dimensions = imageDimensions(mediaType, bytes);
          const metadata: AttachmentMetadataDto = {
            createdAt: now,
            digest: contentDigest,
            filename: normalizedFilename,
            ...(dimensions === undefined ? {} : dimensions),
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
          yield* persistPrivateDocumentState(state, room.documentId, objectStore, digest).pipe(
            Effect.mapError(toApplicationError),
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
          const attachmentReadAt = new Date().toISOString();
          const authorizedMetadata = yield* room.snapshot(principal, attachmentReadAt).pipe(
            Effect.map((snapshot) => snapshot.metadata),
            Effect.catchAll(() =>
              room.snapshot(ownerPrincipal, attachmentReadAt).pipe(
                Effect.tap((snapshot) =>
                  authorizeDocument(
                    principal,
                    "read-published",
                    snapshot.metadata,
                    attachmentReadAt,
                  ),
                ),
                Effect.map((snapshot) => snapshot.metadata),
              ),
            ),
            Effect.mapError(toApplicationError),
          );
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
          return {
            bytes: stored.bytes,
            metadata,
            publicCache:
              principal.kind === "anonymous" &&
              authorizedMetadata.visibility === "public" &&
              authorizedMetadata.publishedRevision !== undefined,
          };
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
            principal,
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
          const needsSetup =
            options.allowOwnerSetup !== false &&
            state.authentication.ownerPasswordHash === undefined;
          if (needsSetup) {
            return {
              authenticated: false,
              authenticationMethods: options.authenticationMethods ?? ["password"],
              needsSetup: true,
            };
          }
          const principal = yield* resolvePrincipal(credentials).pipe(
            Effect.catchAll(() => Effect.succeed({ kind: "anonymous" } as const)),
          );
          return principal.kind === "workspace" || principal.kind === "api-key"
            ? {
                authenticated: true,
                authenticationMethods: options.authenticationMethods ?? ["password"],
                needsSetup: false,
                principal: {
                  displayName:
                    state.authentication.sessions.find(
                      (session) => session.personId === principal.personId,
                    )?.displayName ?? "Owner",
                  id: principal.personId,
                  role: principal.role,
                },
              }
            : {
                authenticated: false,
                authenticationMethods: options.authenticationMethods ?? ["password"],
                needsSetup: false,
              };
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
          yield* authorizeWorkspace(principal, "create-document").pipe(
            Effect.mapError(toApplicationError),
          );
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
          const directoryEntries = yield* Effect.forEach(request.people ?? [], (entry) =>
            personId(entry.email.toLocaleLowerCase("en")).pipe(
              Effect.mapError(toApplicationError),
              Effect.map((id) => ({
                aliases: entry.aliases ?? [],
                person: { displayName: entry.displayName, email: entry.email, id },
              })),
            ),
          );
          yield* withState(
            activateDocument(state.catalog, room.documentId).pipe(
              Effect.flatMap((catalog) =>
                applyCatalogSummary(catalog, summaryFromSnapshot(snapshot)),
              ),
              Effect.map((catalog) => directoryEntries.reduce(upsertPerson, catalog)),
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
          const entries = publicCatalog(state.catalog);
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
              Effect.map((snapshot) => {
                const searchText = normalizeSearchText(
                  `${snapshot.metadata.rfcNumber ?? ""} ${snapshot.metadata.title} ${snapshot.body} ${snapshot.metadata.labels.join(" ")}`,
                );
                return (normalizedQuery.length === 0 || searchText.includes(normalizedQuery)) &&
                  (lifecycleState === undefined ||
                    snapshot.metadata.lifecycleState === lifecycleState) &&
                  (label === undefined || snapshot.metadata.labels.includes(label))
                  ? {
                      excerpt: excerpt(snapshot.body),
                      metadata: {
                        ...snapshot.metadata,
                        publishedRevision,
                      } as DocumentMetadataDto,
                    }
                  : undefined;
              }),
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
          const principal = yield* resolvePrincipal(credentials);
          yield* authorizeWorkspace(principal, "read-catalog").pipe(
            Effect.mapError(toApplicationError),
          );
          const summaries = searchCatalog(state.catalog, query);
          const documents = yield* Effect.forEach(summaries, (summary) =>
            summary.metadata === undefined
              ? getRoom(summary.documentId).pipe(
                  Effect.flatMap((room) => room.snapshot(ownerPrincipal, new Date().toISOString())),
                  Effect.mapError(toApplicationError),
                  Effect.map((snapshot) => ({
                    excerpt: summary.excerpt,
                    metadata: snapshot.metadata as DocumentMetadataDto,
                  })),
                )
              : Effect.succeed({
                  excerpt: summary.excerpt,
                  metadata: summary.metadata as DocumentMetadataDto,
                }),
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
      loginWorkspaceIdentity: (identity) =>
        withState(
          createWorkspaceSession(state.authentication, identity, new Date().toISOString()).pipe(
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
      readPublicDocument: (rawDocumentId) =>
        readPublished(rawDocumentId, `/public/documents/${encodeURIComponent(rawDocumentId)}`),
      readPublicRfc: (rfcNumber) =>
        Effect.gen(function* () {
          const entry = state.catalog.entries.find(
            (item) =>
              item.status === "active" &&
              item.rfcNumber === rfcNumber &&
              item.summary?.visibility === "public" &&
              item.summary.publishedRevision !== undefined,
          );
          if (entry === undefined) {
            return yield* applicationFailure("not_found", "The published RFC does not exist.", 404);
          }
          return yield* readPublished(
            entry.documentId,
            `/rfc/${String(rfcNumber).padStart(4, "0")}`,
          );
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
        options.allowOwnerSetup === false
          ? applicationFailure(
              "owner_setup_disabled",
              "Local owner setup is disabled for this deployment.",
              403,
            )
          : withState(
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
              yield* persistPrivateDocumentState(state, room.documentId, objectStore, digest).pipe(
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

function persistCatalogProjections(
  state: LocalWorkspaceState,
  objectStore: typeof ObjectStore.Service,
  digest: typeof Digest.Service,
): Effect.Effect<void, StorageError> {
  return Effect.gen(function* () {
    const internalBytes = textEncoder.encode(JSON.stringify(state.catalog));
    const publicBytes = textEncoder.encode(
      JSON.stringify({
        documents: publicCatalog(state.catalog).map((summary) => ({
          documentId: summary.documentId,
          publishedRevision: summary.publishedRevision,
          rfcNumber: summary.rfcNumber,
        })),
        generatedAt: new Date().toISOString(),
        schemaVersion: 1,
      }),
    );
    const internalDigest = yield* digest.sha256(internalBytes);
    const publicDigest = yield* digest.sha256(publicBytes);
    yield* Effect.all(
      [
        objectStore.put(`workspaces/${state.workspaceId}/catalog/internal.json`, internalBytes, {
          digest: internalDigest,
          mediaType: "application/json",
        }),
        objectStore.put(`workspaces/${state.workspaceId}/catalog/public.json`, publicBytes, {
          digest: publicDigest,
          mediaType: "application/json",
        }),
      ],
      { concurrency: 2, discard: true },
    );
  });
}

function hydratePrivateDocumentState(
  initial: LocalWorkspaceState,
  objectStore: typeof ObjectStore.Service,
): Effect.Effect<LocalWorkspaceState, StorageError> {
  return Effect.reduce(
    initial.catalog.entries.filter((entry) => entry.status === "active"),
    initial,
    (current, entry) =>
      objectStore.get(privateDocumentStateKey(current.workspaceId, entry.documentId)).pipe(
        Effect.flatMap((stored) => {
          if (stored === undefined) return Effect.succeed(current);
          return Schema.decodeUnknown(Schema.parseJson(privateDocumentStateSchema))(
            textDecoder.decode(stored.bytes),
          ).pipe(
            Effect.mapError(
              (cause) =>
                new StorageError({
                  cause,
                  message: `Private document state is corrupt for ${entry.documentId}.`,
                  operation: "decode private document state",
                  retryable: false,
                }),
            ),
            Effect.map((decoded) => {
              const localCapabilities = current.capabilities.filter(
                (capability) => capability.documentId === entry.documentId,
              );
              const projectedCapabilities = decoded.capabilities as readonly CapabilityRecord[];
              const localGeneration = Math.max(
                -1,
                ...localCapabilities.map((item) => item.generation),
              );
              const projectedGeneration = Math.max(
                -1,
                ...projectedCapabilities.map((item) => item.generation),
              );
              const capabilities =
                projectedGeneration >= localGeneration
                  ? [
                      ...current.capabilities.filter(
                        (capability) => capability.documentId !== entry.documentId,
                      ),
                      ...projectedCapabilities,
                    ]
                  : current.capabilities;
              const projectedAttachments =
                decoded.attachments as unknown as readonly AttachmentMetadataDto[];
              const attachments = [
                ...(current.attachments[entry.documentId] ?? []),
                ...projectedAttachments,
              ].filter(
                (attachment, index, all) =>
                  all.findIndex((candidate) => candidate.id === attachment.id) === index,
              );
              return {
                ...current,
                attachments: { ...current.attachments, [entry.documentId]: attachments },
                capabilities,
              };
            }),
          );
        }),
      ),
  );
}

function persistPrivateDocumentState(
  state: LocalWorkspaceState,
  documentKey: string,
  objectStore: typeof ObjectStore.Service,
  digest: typeof Digest.Service,
): Effect.Effect<void, StorageError> {
  return Effect.gen(function* () {
    const bytes = textEncoder.encode(
      JSON.stringify({
        attachments: state.attachments[documentKey] ?? [],
        capabilities: state.capabilities.filter(
          (capability) => capability.documentId === documentKey,
        ),
        schemaVersion: 1,
      }),
    );
    const contentDigest = yield* digest.sha256(bytes);
    yield* objectStore.put(privateDocumentStateKey(state.workspaceId, documentKey), bytes, {
      digest: contentDigest,
      mediaType: "application/json",
    });
  });
}

function privateDocumentStateKey(workspaceId: string, documentKey: string): string {
  return `workspaces/${workspaceId}/documents/${documentKey}/private-state.json`;
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
  return summaryFromDocument(toDocumentResponse(snapshot));
}

function summaryFromDocument(document: DocumentResponse): CatalogSummary {
  const body = normalizeSearchText(document.body);
  return {
    approvers: document.metadata.approvers as readonly PersonReference[],
    authors: document.metadata.authors as readonly PersonReference[],
    documentId: document.metadata.id as DocumentMetadata["id"],
    excerpt: excerpt(document.body),
    labels: document.metadata.labels,
    metadata: document.metadata as DocumentMetadata,
    normalizedBody: body,
    publishedRevision: document.metadata.publishedRevision as DocumentRevision | undefined,
    revision: document.metadata.headRevision as DocumentRevision,
    reviewers: document.metadata.reviewers as readonly PersonReference[],
    rfcNumber: document.metadata.rfcNumber,
    sensitivity: document.metadata.sensitivity,
    state: document.metadata.lifecycleState,
    title: document.metadata.title,
    updatedAt: document.metadata.updatedAt,
    visibility: document.metadata.visibility,
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

function imageDimensions(
  mediaType: string,
  bytes: Uint8Array,
): { readonly height: number; readonly width: number } | undefined {
  if (
    mediaType === "image/png" &&
    bytes.length >= 24 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return validDimensions(unsigned32(bytes, 16), unsigned32(bytes, 20));
  }
  if (
    mediaType === "image/gif" &&
    bytes.length >= 10 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46
  ) {
    return validDimensions(
      (bytes[6] ?? 0) | ((bytes[7] ?? 0) << 8),
      (bytes[8] ?? 0) | ((bytes[9] ?? 0) << 8),
    );
  }
  if (mediaType === "image/jpeg" && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 8 < bytes.length) {
      if (bytes[offset] !== 0xff) break;
      const marker = bytes[offset + 1] ?? 0;
      const length = ((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0);
      if (length < 2) break;
      if (marker >= 0xc0 && marker <= 0xc3) {
        return validDimensions(
          ((bytes[offset + 7] ?? 0) << 8) | (bytes[offset + 8] ?? 0),
          ((bytes[offset + 5] ?? 0) << 8) | (bytes[offset + 6] ?? 0),
        );
      }
      offset += length + 2;
    }
  }
  return undefined;
}

function validDimensions(
  width: number,
  height: number,
): { readonly height: number; readonly width: number } | undefined {
  return width > 0 && height > 0 && width <= 100_000 && height <= 100_000
    ? { height, width }
    : undefined;
}

function unsigned32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) * 0x1000000 +
      ((bytes[offset + 1] ?? 0) << 16) +
      ((bytes[offset + 2] ?? 0) << 8) +
      (bytes[offset + 3] ?? 0)) >>>
    0
  );
}

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
