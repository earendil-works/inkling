import { Effect, Either, Fiber, Layer, Option, Predicate, Schema, Stream } from "effect";

import {
  activateDocument,
  allocateRfcNumber,
  applyCatalogSummary,
  apiKeyBelongsTo,
  authenticateApiKey,
  authorizeDocument,
  authorizeWorkspace,
  authenticateSession,
  AuthenticationError,
  AuthorizationError,
  BodyEditError,
  createApiKey,
  createAuthorizationCode,
  createDocumentMetadata,
  createWorkspaceSession,
  Digest,
  documentActions,
  documentId,
  documentRevision,
  documentTitleFromMarkdown,
  DomainError,
  DurableDocumentJournal,
  emptyAuthenticationState,
  emptyWorkspaceCatalog,
  filterCatalog,
  IdGenerator,
  identifierTag,
  isAdministrator,
  isDocumentActionAllowed,
  ObjectStore,
  parseCatalogSearchQuery,
  personId,
  publicCatalog,
  purgeDocument,
  readLineRange,
  reserveDocument,
  requireRevision,
  resolveAuthorsByEmail,
  revokeApiKey,
  searchCatalog,
  SearchIndex,
  isDocumentTrashExpired,
  SecretHasher,
  SecureToken,
  TokenHasher,
  StorageError,
  takeAuthorizationCode,
  tombstoneDocument,
  upsertPerson,
  WorkspaceStateStore,
  logoutSession,
  normalizeSearchText,
  normalizeWorkspaceCatalog,
  verifyAuthorizationCode,
} from "@earendil-works/inkling-core";
import type {
  ApiKeyRecord,
  AuthenticationState,
  AuthorizationCodeRecord,
  CapabilityAccess,
  CatalogHeading,
  CatalogSummary,
  CommentActor,
  DocumentId,
  DocumentMetadata,
  DocumentRevision,
  MetadataPatch,
  PersonReference,
  Principal,
  RelatedDocumentReference,
  SessionRecord,
  WorkspaceCatalogState,
} from "@earendil-works/inkling-core";
import {
  CollaborationError,
  decodeBase64,
  encodeBase64,
  loadDocumentHistoryRevision,
  loadDocumentRevision,
  readDocumentHistory,
  makeDocumentAuthority,
  RecoveryError,
} from "@earendil-works/inkling-collaboration";
import type {
  DocumentAuthorityService,
  DocumentSnapshot,
} from "@earendil-works/inkling-collaboration";
import { ApplicationError, InklingApplication } from "./application.ts";
import { canonicalRfcPath, protectedLinkPath, referenceLinkPath } from "./routes.ts";
import type {
  CollaborationConnection,
  DocumentRuntimeConfiguration,
  InklingApplicationService,
  RequestCredentials,
} from "./application.ts";
import type {
  ApiKeyCreated,
  ApiKeyDto,
  AttachmentMetadataDto,
  CatalogResponse,
  CommentStateDto,
  DocumentHistoryResponse,
  DocumentMetadataDto,
  DocumentResponse,
  ImportDocumentRequest,
  MetadataPatchRequest,
  PassageSearchResponse,
  PublicDocumentResponse,
  ReferenceResolutionDto,
  ReferenceResolutionsResponse,
  SearchPassageDto,
  SearchRebuildResponse,
  ServerCollaborationMessage,
  ShareLinkCreateRequest,
  ShareLinkDto,
  ShareLinksResponse,
} from "@earendil-works/inkling-protocol";
import {
  collectReferences,
  MarkdownRenderer,
  outlineDocument,
  parseDocumentSource,
  parseReference,
  redactReferences,
  referenceTargetPath,
  RenderError,
  serializeDocumentFrontmatter,
} from "@earendil-works/inkling-renderer";
import type {
  DocumentOutline,
  DocumentReference,
  ParsedReference,
  ReferenceResolutions,
} from "@earendil-works/inkling-renderer";
import { maximumReferencesPerRequest } from "@earendil-works/inkling-protocol";

const textEncoder = new TextEncoder();
const maximumCachedPublishedRevisions = 128;
/** How long the catalog may settle before its object storage projections are written. */
const catalogProjectionDelayMilliseconds = 2_000;
/** Collaboration updates refresh a document's catalog entry and search at most this often. */
const documentProjectionIntervalMilliseconds = 2_000;
const textDecoder = new TextDecoder();

interface CapabilityRecord {
  readonly id: string;
  readonly documentId: string;
  readonly tokenHash: string;
  readonly generation: number;
  readonly access: Exclude<CapabilityAccess, "disabled">;
  readonly createdAt?: string | undefined;
  readonly expiresAt?: string | undefined;
  readonly passwordHash?: string | undefined;
  readonly passwordProof?: string | undefined;
  readonly retainedSecret?: string | undefined;
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
      createdAt: Schema.optional(Schema.String),
      documentId: Schema.String,
      expiresAt: Schema.optional(Schema.String),
      generation: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
      id: Schema.String,
      passwordHash: Schema.optional(Schema.String),
      passwordProof: Schema.optional(Schema.String),
      retainedSecret: Schema.optional(Schema.String),
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
      createdAt: Schema.optional(Schema.String),
      documentId: Schema.String,
      expiresAt: Schema.optional(Schema.String),
      generation: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
      id: Schema.String,
      passwordHash: Schema.optional(Schema.String),
      passwordProof: Schema.optional(Schema.String),
      retainedSecret: Schema.optional(Schema.String),
      tokenHash: Schema.String,
    }),
  ),
  catalog: Schema.Unknown,
  schemaVersion: Schema.Literal(1),
  workspaceId: Schema.String,
});

export interface LocalApplicationOptions {
  readonly workspaceId?: string | undefined;
  readonly ownsDocumentPrivateState?: boolean | undefined;
  /** Whether this runtime writes the workspace catalog projections; document authorities do not. */
  readonly ownsCatalogProjections?: boolean | undefined;
  readonly principalResolver?:
    | ((
        credentials: RequestCredentials,
        documentId?: string,
      ) => Effect.Effect<Principal, ApplicationError>)
    | undefined;
  readonly peopleResolver?:
    | ((emails: readonly string[]) => Effect.Effect<readonly PersonReference[], ApplicationError>)
    | undefined;
  /** Resolves references through the runtime that owns the workspace catalog. */
  readonly referenceResolver?:
    | ((
        credentials: RequestCredentials,
        references: readonly string[],
      ) => Effect.Effect<ReferenceResolutionsResponse, ApplicationError>)
    | undefined;
}

export function makeLocalInklingApplication(
  options: LocalApplicationOptions = {},
): Effect.Effect<
  InklingApplicationService,
  StorageError,
  | typeof WorkspaceStateStore.Service
  | typeof ObjectStore.Service
  | typeof DurableDocumentJournal.Service
  | typeof Digest.Service
  | typeof SecretHasher.Service
  | typeof TokenHasher.Service
  | typeof SecureToken.Service
  | typeof IdGenerator.Service
  | typeof MarkdownRenderer.Service
  | typeof SearchIndex.Service
> {
  return Effect.gen(function* () {
    const stateStore = yield* WorkspaceStateStore;
    const objectStore = yield* ObjectStore;
    const journal = yield* DurableDocumentJournal;
    const digest = yield* Digest;
    const hasher = yield* SecretHasher;
    const tokenHasher = yield* TokenHasher;
    const tokens = yield* SecureToken;
    const ids = yield* IdGenerator;
    const renderer = yield* MarkdownRenderer;
    const searchIndex = yield* SearchIndex;
    const stateMutex = yield* Effect.makeSemaphore(1);
    const roomMutex = yield* Effect.makeSemaphore(1);
    const rooms = new Map<string, DocumentAuthorityService>();
    const checkpointFibers = new Map<string, Fiber.RuntimeFiber<void, never>>();
    const dirtySince = new Map<string, number>();
    let state = yield* loadWorkspaceState(stateStore, options.workspaceId ?? "local");
    // A runtime that owns private document state reads all of it when it
    // starts. The workspace authority only mirrors what document authorities
    // own, so it reads a document's state the first time it needs it, and a
    // cold start waits for no object reads.
    const hydratedPrivateState = new Set<string>();
    if (options.ownsDocumentPrivateState !== false) {
      state = mergePrivateDocumentStates(
        state,
        yield* loadPrivateDocumentStates(
          state.workspaceId,
          state.catalog.entries
            .filter((entry) => entry.status === "active")
            .map((entry) => entry.documentId),
          objectStore,
        ),
      );
    }
    const systemId = yield* personId("system@internal").pipe(Effect.mapError(toStorageError));
    const systemPrincipal: Principal = {
      kind: "workspace",
      personId: systemId,
      role: "administrator",
      system: true,
    };

    // The catalog files in object storage are projections kept for backups.
    // They are written once the catalog settles rather than on every save,
    // and only by the runtime that owns the workspace catalog.
    const catalogProjectionMutex = yield* Effect.makeSemaphore(1);
    let persistedCatalog: WorkspaceCatalogState | undefined;
    let catalogProjectionFiber: Fiber.RuntimeFiber<void, never> | undefined;

    const flushCatalogProjections: Effect.Effect<void> = catalogProjectionMutex.withPermits(1)(
      Effect.suspend(() => {
        const current = state;
        if (options.ownsCatalogProjections === false || current.catalog === persistedCatalog) {
          return Effect.void;
        }
        return persistCatalogProjections(current, objectStore, digest).pipe(
          Effect.tap(() => Effect.sync(() => (persistedCatalog = current.catalog))),
          Effect.catchAll((error) =>
            Effect.logWarning("Catalog projection write failed", error.message),
          ),
        );
      }),
    );

    const scheduleCatalogProjections: Effect.Effect<void> = Effect.suspend(() => {
      if (options.ownsCatalogProjections === false || catalogProjectionFiber !== undefined) {
        return Effect.void;
      }
      return Effect.sleep(catalogProjectionDelayMilliseconds).pipe(
        // Saves from here on schedule another write, so the last one is never missed.
        Effect.ensuring(Effect.sync(() => (catalogProjectionFiber = undefined))),
        Effect.zipRight(flushCatalogProjections),
        Effect.forkDaemon,
        Effect.flatMap((fiber) => Effect.sync(() => (catalogProjectionFiber = fiber))),
      );
    });

    const saveState = (next: LocalWorkspaceState): Effect.Effect<void, StorageError> =>
      stateStore.save(next).pipe(
        Effect.tap(() => Effect.sync(() => (state = next))),
        Effect.tap(() =>
          next.catalog === persistedCatalog ? Effect.void : scheduleCatalogProjections,
        ),
      );

    const withState = stateMutex.withPermits(1);

    /** Mirrors the private state of documents not read yet; see `hydratedPrivateState`. */
    const ensurePrivateDocumentState = (
      documentIds: readonly string[],
    ): Effect.Effect<void, ApplicationError> =>
      Effect.suspend(() => {
        if (options.ownsDocumentPrivateState !== false) return Effect.void;
        const pending = [...new Set(documentIds)].filter((id) => !hydratedPrivateState.has(id));
        if (pending.length === 0) return Effect.void;
        return loadPrivateDocumentStates(state.workspaceId, pending, objectStore).pipe(
          Effect.flatMap((stored) =>
            withState(
              Effect.sync(() => {
                state = mergePrivateDocumentStates(state, stored);
                for (const id of pending) hydratedPrivateState.add(id);
              }),
            ),
          ),
          Effect.mapError(toApplicationError),
        );
      });

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

    // Published revisions never change, so each is read from storage once.
    // Reads of public documents and catalogs otherwise fetch every revision
    // from object storage on every request.
    const publishedRevisions = new Map<string, DocumentSnapshot>();
    const loadPublishedRevision = (
      id: DocumentId,
      revision: DocumentRevision,
    ): Effect.Effect<DocumentSnapshot, ApplicationError> => {
      const key = `${state.workspaceId}:${id}:${revision}`;
      const cached = publishedRevisions.get(key);
      if (cached !== undefined) {
        publishedRevisions.delete(key);
        publishedRevisions.set(key, cached);
        return Effect.succeed(cached);
      }
      return provideAuthorityDependencies(
        loadDocumentRevision({ documentId: id, workspaceId: state.workspaceId }, revision),
      ).pipe(
        Effect.mapError(toApplicationError),
        Effect.tap((snapshot) =>
          Effect.sync(() => {
            publishedRevisions.set(key, snapshot);
            for (const oldest of publishedRevisions.keys()) {
              if (publishedRevisions.size <= maximumCachedPublishedRevisions) break;
              publishedRevisions.delete(oldest);
            }
          }),
        ),
      );
    };

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
            (entry) =>
              entry.documentId === id && (entry.status === "active" || entry.status === "deleted"),
          );
          if (registered === undefined) {
            return yield* applicationFailure("not_found", "The document does not exist.", 404);
          }
          const room = yield* provideAuthorityDependencies(
            makeDocumentAuthority({ documentId: id, workspaceId: state.workspaceId }),
          ).pipe(Effect.mapError(toApplicationError));
          const now = new Date().toISOString();
          const current = yield* room
            .snapshot(systemPrincipal, now)
            .pipe(Effect.mapError(toApplicationError));
          const scaffoldedBody = withMetadataFrontmatter(current.body, current.metadata);
          if (scaffoldedBody !== current.body) {
            yield* room
              .replaceBody(systemPrincipal, scaffoldedBody, current.metadata.headRevision, now)
              .pipe(Effect.mapError(toApplicationError));
            yield* room.checkpoint(now).pipe(Effect.mapError(toApplicationError));
          }
          rooms.set(id, room);
          return room;
        }),
      );

    const scheduleCheckpoint = (room: DocumentAuthorityService): Effect.Effect<void> =>
      Effect.gen(function* () {
        const started = dirtySince.get(room.documentId) ?? Date.now();
        const existing = checkpointFibers.get(room.documentId);
        if (existing !== undefined) {
          yield* Fiber.interrupt(existing);
        }
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

    /**
     * Stores a credential record that authentication refreshed. The record is
     * merged into the current state so concurrent changes, such as a
     * revocation or logout, are kept. Failing to record use or to upgrade a
     * hash never fails the request; the next request tries again.
     */
    const storeAuthenticatedRecord = (
      update:
        | { readonly apiKey: ApiKeyRecord; readonly session?: undefined }
        | { readonly apiKey?: undefined; readonly session: SessionRecord },
    ): Effect.Effect<void> =>
      withState(
        Effect.suspend(() => {
          const { apiKeys, sessions } = state.authentication;
          let authentication: AuthenticationState | undefined;
          if (update.apiKey === undefined) {
            const index = sessions.findIndex((record) => record.id === update.session.id);
            const current = sessions[index];
            authentication =
              current === undefined
                ? undefined
                : {
                    ...state.authentication,
                    sessions: sessions.with(index, {
                      ...current,
                      tokenHash: update.session.tokenHash,
                    }),
                  };
          } else {
            const index = apiKeys.findIndex((record) => record.id === update.apiKey.id);
            const current = apiKeys[index];
            authentication =
              current === undefined
                ? undefined
                : {
                    ...state.authentication,
                    apiKeys: apiKeys.with(index, {
                      ...current,
                      lastUsedAt: update.apiKey.lastUsedAt,
                      tokenHash: update.apiKey.tokenHash,
                    }),
                  };
          }
          return authentication === undefined
            ? Effect.void
            : saveState({ ...state, authentication });
        }),
      ).pipe(
        Effect.catchAll((error) =>
          Effect.logWarning("Authenticated credential update failed", error.message),
        ),
      );

    // Authentication only reads the state, so it never waits for the state
    // lock; only the occasional record refresh takes it.
    const resolveStoredPrincipal = (
      credentials: RequestCredentials,
    ): Effect.Effect<Principal, ApplicationError> =>
      Effect.gen(function* () {
        const now = new Date().toISOString();
        if (credentials.bearerToken !== undefined) {
          const authenticated = yield* authenticateApiKey(
            state.authentication,
            credentials.bearerToken,
            now,
          ).pipe(
            Effect.provideService(TokenHasher, tokenHasher),
            Effect.mapError(toApplicationError),
          );
          if (authenticated.updatedRecord !== undefined) {
            yield* storeAuthenticatedRecord({ apiKey: authenticated.updatedRecord });
          }
          return authenticated.principal;
        }
        if (credentials.sessionToken !== undefined) {
          const authenticated = yield* authenticateSession(
            state.authentication,
            credentials.sessionToken,
            now,
          ).pipe(
            Effect.provideService(TokenHasher, tokenHasher),
            Effect.mapError(toApplicationError),
          );
          if (authenticated.updatedRecord !== undefined) {
            yield* storeAuthenticatedRecord({ session: authenticated.updatedRecord });
          }
          return authenticated.principal;
        }
        return { kind: "anonymous" } as const;
      });

    /** Who signed in, from the workspace's sessions and keys; never a share link. */
    const resolveAccount = (
      credentials: RequestCredentials,
      targetDocumentId?: string,
    ): Effect.Effect<Principal, ApplicationError> => {
      if (credentials.bearerToken === undefined && credentials.sessionToken === undefined) {
        return Effect.succeed({ kind: "anonymous" });
      }
      const account: RequestCredentials = {
        bearerToken: credentials.bearerToken,
        sessionToken: credentials.sessionToken,
      };
      return options.principalResolver === undefined
        ? resolveStoredPrincipal(account)
        : options.principalResolver(account, targetDocumentId);
    };

    /**
     * Share links belong to the document's private state, so the runtime that
     * owns the document resolves them, while the workspace resolves who signed
     * in. Signed-in people who open a link act as themselves, with the link's
     * access added; everyone else acts as the link's guest.
     */
    const resolvePrincipal = (
      credentials: RequestCredentials,
      targetDocumentId?: string,
    ): Effect.Effect<Principal, ApplicationError> => {
      if (credentials.internalPrincipal !== undefined) {
        return Effect.succeed(credentials.internalPrincipal);
      }
      return resolveAccount(credentials, targetDocumentId).pipe(
        Effect.flatMap((principal) => {
          const token = credentials.capabilityToken;
          if (token === undefined || targetDocumentId === undefined) {
            return Effect.succeed(principal);
          }
          const guest = ensurePrivateDocumentState([targetDocumentId]).pipe(
            Effect.zipRight(
              Effect.suspend(() =>
                resolveCapability(
                  state,
                  token,
                  targetDocumentId,
                  credentials.guestName,
                  credentials.capabilityProof,
                  tokenHasher,
                ),
              ),
            ),
          );
          if (principal.kind !== "workspace" && principal.kind !== "api-key") return guest;
          return guest.pipe(
            Effect.map(
              ({ access, documentId: grantedDocumentId, expiresAt, generation }): Principal => ({
                ...principal,
                capability: { access, documentId: grantedDocumentId, expiresAt, generation },
              }),
            ),
            // A link that no longer works leaves the person with their own
            // access; a password still has to be entered to use the link.
            Effect.catchIf(
              (error) => error.code !== "capability_password_required",
              () => Effect.succeed(principal),
            ),
          );
        }),
      );
    };

    const responseFromSnapshot = (
      snapshot: DocumentSnapshot,
      startLine?: number,
      endLine?: number,
    ): Effect.Effect<DocumentResponse, ApplicationError> =>
      startLine === undefined && endLine === undefined
        ? Effect.succeed(toDocumentResponse(snapshot))
        : readLineRange(snapshot.body, {
            end: endLine ?? Number.MAX_SAFE_INTEGER,
            start: startLine ?? 1,
          }).pipe(
            Effect.mapError(toApplicationError),
            Effect.map((body) => toDocumentResponse({ ...snapshot, body })),
          );

    const snapshotFor = (
      room: DocumentAuthorityService,
      principal: Principal,
      startLine?: number,
      endLine?: number,
    ): Effect.Effect<DocumentResponse, ApplicationError> =>
      room.snapshot(principal, new Date().toISOString()).pipe(
        Effect.mapError(toApplicationError),
        Effect.flatMap((snapshot) => responseFromSnapshot(snapshot, startLine, endLine)),
      );

    const publishedSnapshotFor = (
      room: DocumentAuthorityService,
      principal: Principal,
      startLine?: number,
      endLine?: number,
    ): Effect.Effect<DocumentResponse, ApplicationError> =>
      Effect.gen(function* () {
        const now = new Date().toISOString();
        const current = yield* room
          .snapshot(systemPrincipal, now)
          .pipe(Effect.mapError(toApplicationError));
        yield* authorizeDocument(
          principal,
          principal.kind === "anonymous" ? "read-published" : "read-working",
          current.metadata,
          now,
        ).pipe(Effect.mapError(toApplicationError));
        if (current.metadata.deletedAt !== undefined) {
          return {
            ...toDocumentResponse(current),
            body: "",
            comments: { revision: current.comments.revision, threads: [] },
          };
        }
        // Personal documents are never published, so whoever may read them
        // this far, their owner, people they are shared with, or a share
        // link, reads the working draft instead.
        if (current.metadata.personalOwner !== undefined) {
          return yield* responseFromSnapshot(current, startLine, endLine);
        }
        const publishedRevision = current.metadata.publishedRevision;
        if (publishedRevision === undefined) {
          return {
            ...toDocumentResponse(current),
            body: "",
            comments: { revision: 0, threads: [] },
          };
        }
        const published = yield* loadPublishedRevision(current.metadata.id, publishedRevision);
        const metadata = yield* metadataWithResolvedAuthors(published.metadata);
        const anonymousBody =
          principal.kind === "anonymous"
            ? yield* renderer.render(published.body).pipe(
                Effect.mapError(toApplicationError),
                Effect.flatMap((rendered) =>
                  anonymousReferenceResolutions(rendered.references).pipe(
                    Effect.map((resolutions) =>
                      rewriteProtectedLinkSources(
                        redactUnavailableReferences(
                          published.body,
                          rendered.references,
                          resolutions,
                          (index) =>
                            referenceLinkPath(current.metadata.id, publishedRevision, index),
                        ),
                        rendered.protectedLinks,
                        ({ index }) =>
                          protectedLinkPath(current.metadata.id, publishedRevision, index),
                      ),
                    ),
                  ),
                ),
              )
            : published.body;
        return yield* responseFromSnapshot(
          {
            ...published,
            body: anonymousBody,
            metadata: {
              ...metadata,
              publishedRevision,
              sharing: current.metadata.sharing,
            },
          },
          startLine,
          endLine,
        );
      });

    const publishedOutlines = new Map<string, DocumentOutline>();

    /** The title and headings of a published revision; revisions never change. */
    const publishedOutline = (
      id: DocumentId,
      revision: DocumentRevision,
      numbered: boolean,
    ): Effect.Effect<DocumentOutline, ApplicationError> => {
      const key = `${state.workspaceId}:${id}:${revision}:${numbered ? "numbered" : "plain"}`;
      const cached = publishedOutlines.get(key);
      if (cached !== undefined) return Effect.succeed(cached);
      return loadPublishedRevision(id, revision).pipe(
        Effect.flatMap((published) =>
          outlineDocument(published.body, { numberHeadings: numbered }).pipe(
            Effect.map((outline) => ({
              ...outline,
              title: published.metadata.title,
            })),
            Effect.mapError(toApplicationError),
          ),
        ),
        Effect.tap((outline) =>
          Effect.sync(() => {
            publishedOutlines.set(key, outline);
            for (const oldest of publishedOutlines.keys()) {
              if (publishedOutlines.size <= maximumCachedPublishedRevisions) break;
              publishedOutlines.delete(oldest);
            }
          }),
        ),
      );
    };

    /**
     * What the principal may learn about a reference: the published revision
     * when it may read that, otherwise the working draft when it may read
     * that, otherwise nothing, so readers cannot tell a private document from
     * a missing one.
     */
    const resolveReference = (
      principal: Principal,
      reference: ParsedReference,
      now: string,
    ): Effect.Effect<ReferenceResolutionDto> =>
      Effect.gen(function* () {
        const unavailable: ReferenceResolutionDto = { status: "unavailable" };
        const target = reference.target;
        const entry = state.catalog.entries.find(
          (candidate) =>
            candidate.status === "active" &&
            (target.kind === "rfc"
              ? (candidate.rfcNumber ?? candidate.summary?.rfcNumber) === target.rfcNumber
              : candidate.documentId === target.documentId),
        );
        const summary = entry?.summary;
        const metadata = summary?.metadata;
        if (entry === undefined || summary === undefined || metadata === undefined) {
          return unavailable;
        }
        const rfcNumber = entry.rfcNumber ?? summary.rfcNumber;
        const publishedRevision = metadata.publishedRevision;
        let outline: {
          readonly headings: readonly CatalogHeading[];
          readonly title: string;
        };
        if (
          publishedRevision !== undefined &&
          isDocumentActionAllowed(principal, "read-published", metadata, now)
        ) {
          const published = yield* publishedOutline(
            entry.documentId,
            publishedRevision,
            rfcNumber !== undefined,
          ).pipe(Effect.option);
          if (Option.isNone(published)) return unavailable;
          outline = {
            headings: published.value.headings,
            title: published.value.title ?? summary.title,
          };
        } else if (isDocumentActionAllowed(principal, "read-working", metadata, now)) {
          outline = { headings: summary.headings ?? [], title: summary.title };
        } else {
          return unavailable;
        }
        const heading =
          reference.anchor === undefined
            ? undefined
            : outline.headings.find((candidate) => candidate.id === reference.anchor);
        return {
          href:
            rfcNumber === undefined
              ? `/documents/${encodeURIComponent(entry.documentId)}`
              : canonicalRfcPath(rfcNumber),
          ...(rfcNumber === undefined ? {} : { rfcNumber }),
          ...(heading === undefined
            ? {}
            : {
                section: {
                  id: heading.id,
                  ...(heading.number === undefined ? {} : { number: heading.number }),
                  text: heading.text,
                },
              }),
          status: "available",
          title: outline.title,
        };
      });

    const resolveReferencesFor = (
      principal: Principal,
      keys: readonly string[],
    ): Effect.Effect<ReferenceResolutionsResponse> =>
      Effect.gen(function* () {
        yield* flushPendingProjections;
        const now = new Date().toISOString();
        const references: Record<string, ReferenceResolutionDto> = {};
        for (const key of new Set(keys)) {
          const reference = parseReference(key);
          references[key] =
            reference === undefined
              ? { status: "unavailable" }
              : yield* resolveReference(principal, reference, now);
        }
        return { references };
      });

    /**
     * Resolves references as an anonymous reader sees them. A section an
     * anonymous reader cannot find counts as unavailable, so its ID stays
     * hidden. Failures leave every reference unavailable.
     */
    const anonymousReferenceResolutions = (
      references: readonly DocumentReference[],
    ): Effect.Effect<ReferenceResolutions> => {
      const keys = [...new Set(references.map((reference) => reference.key))];
      if (keys.length === 0) return Effect.succeed(new Map());
      const resolved =
        options.referenceResolver === undefined
          ? resolveReferencesFor({ kind: "anonymous" }, keys)
          : options.referenceResolver({}, keys);
      return resolved.pipe(
        Effect.map(
          (response) =>
            new Map(
              references.map((reference) => {
                const resolution = response.references[reference.key];
                return [
                  reference.key,
                  resolution?.status === "available" &&
                  (reference.anchor === undefined || resolution.section !== undefined)
                    ? resolution
                    : ({ status: "unavailable" } as const),
                ];
              }),
            ),
        ),
        Effect.catchAll((error) =>
          Effect.logWarning("Reference resolution failed", error.message).pipe(
            Effect.as(
              new Map(
                references.map((reference) => [reference.key, { status: "unavailable" } as const]),
              ),
            ),
          ),
        ),
      );
    };

    const indexDocumentVariants = (
      document: DocumentResponse,
    ): Effect.Effect<void, ApplicationError> =>
      Effect.gen(function* () {
        if (!searchIndex.enabled) return;
        const id = document.metadata.id as DocumentId;
        const entry = state.catalog.entries.find((candidate) => candidate.documentId === id);
        if (entry?.status !== "active" || document.metadata.deletedAt !== undefined) {
          yield* searchIndex.removeDocument(id);
          return;
        }
        yield* searchIndex.indexDocument({
          body: document.body,
          documentId: id,
          revision: document.metadata.headRevision as DocumentRevision,
          title: document.metadata.title,
          variant: "working",
        });
        const publishedRevision = document.metadata.publishedRevision as
          | DocumentRevision
          | undefined;
        if (publishedRevision === undefined) {
          yield* searchIndex.removeDocument(id, "published");
          return;
        }
        if ((yield* searchIndex.indexedRevision(id, "published")) === publishedRevision) return;
        const published = yield* loadPublishedRevision(id, publishedRevision);
        yield* searchIndex.indexDocument({
          body: redactPublicText(published.body),
          documentId: id,
          revision: publishedRevision,
          title: published.metadata.title,
          variant: "published",
        });
      }).pipe(Effect.mapError(toApplicationError));

    /** The search index is a projection: its failures are logged, never surfaced to writers. */
    const updateSearchIndex = (document: DocumentResponse): Effect.Effect<void> =>
      indexDocumentVariants(document).pipe(
        Effect.catchAll((error) =>
          Effect.logError("Search index update failed", {
            code: error.code,
            documentId: document.metadata.id,
            message: error.message,
          }),
        ),
      );

    const projectDocument = (
      room: DocumentAuthorityService,
    ): Effect.Effect<void, ApplicationError> =>
      Effect.gen(function* () {
        const snapshot = yield* room
          .snapshot(systemPrincipal, new Date().toISOString())
          .pipe(Effect.mapError(toApplicationError));
        const summary = yield* summaryFromSnapshot(snapshot);
        yield* withState(
          applyCatalogSummary(state.catalog, summary).pipe(
            Effect.mapError(toApplicationError),
            Effect.flatMap((catalog) =>
              saveState({ ...state, catalog }).pipe(Effect.mapError(toApplicationError)),
            ),
          ),
        );
        yield* updateSearchIndex(toDocumentResponse(snapshot));
      });

    const projectDocumentStatus = (
      room: DocumentAuthorityService,
      status: "active" | "deleted",
    ): Effect.Effect<void, ApplicationError> =>
      Effect.gen(function* () {
        const snapshot = yield* room
          .snapshot(systemPrincipal, new Date().toISOString())
          .pipe(Effect.mapError(toApplicationError));
        const summary = yield* summaryFromSnapshot(snapshot);
        yield* withState(
          applyCatalogSummary(state.catalog, summary).pipe(
            Effect.flatMap((catalog) =>
              status === "active"
                ? activateDocument(catalog, room.documentId)
                : tombstoneDocument(catalog, room.documentId),
            ),
            Effect.mapError(toApplicationError),
            Effect.flatMap((catalog) =>
              saveState({ ...state, catalog }).pipe(Effect.mapError(toApplicationError)),
            ),
          ),
        );
        yield* updateSearchIndex(toDocumentResponse(snapshot));
      });

    const projectionFibers = new Map<string, Fiber.RuntimeFiber<void, never>>();

    /**
     * Projects a document after collaboration updates. Keystrokes arrive far
     * more often than anyone reads the catalog, so updates within one
     * interval share a single projection taken when the interval ends.
     */
    const scheduleProjection = (room: DocumentAuthorityService): Effect.Effect<void> =>
      Effect.suspend(() => {
        if (projectionFibers.has(room.documentId)) return Effect.void;
        return Effect.sleep(documentProjectionIntervalMilliseconds).pipe(
          // Updates from here on schedule another projection, so the last
          // update is always covered by a snapshot taken after it.
          Effect.ensuring(Effect.sync(() => projectionFibers.delete(room.documentId))),
          Effect.zipRight(projectDocument(room)),
          Effect.catchAll((error) => Effect.logError("Document projection failed", error.message)),
          Effect.forkDaemon,
          Effect.flatMap((fiber) =>
            Effect.sync(() => {
              projectionFibers.set(room.documentId, fiber);
            }),
          ),
        );
      });

    /**
     * Brings throttled projections up to date before a catalog read in the
     * same process, so readers here never see an entry older than its
     * document. Document authorities in other processes stay on the throttle.
     */
    const flushPendingProjections: Effect.Effect<void> = Effect.suspend(() =>
      Effect.forEach(
        [...projectionFibers],
        ([id, fiber]) =>
          Effect.gen(function* () {
            projectionFibers.delete(id);
            yield* Fiber.interrupt(fiber);
            const room = rooms.get(id);
            if (room === undefined) return;
            yield* projectDocument(room).pipe(
              Effect.catchAll((error) =>
                Effect.logError("Document projection failed", error.message),
              ),
            );
          }),
        { discard: true },
      ),
    );

    const releaseDocumentRoom = (rawDocumentId: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        const room = rooms.get(rawDocumentId);
        const checkpointFiber = checkpointFibers.get(rawDocumentId);
        if (checkpointFiber !== undefined) yield* Fiber.interrupt(checkpointFiber);
        const projectionFiber = projectionFibers.get(rawDocumentId);
        if (projectionFiber !== undefined) yield* Fiber.interrupt(projectionFiber);
        if (room !== undefined) yield* room.close;
        checkpointFibers.delete(rawDocumentId);
        dirtySince.delete(rawDocumentId);
        rooms.delete(rawDocumentId);
      });

    const removeDocumentState = (rawDocumentId: string): Effect.Effect<void, ApplicationError> =>
      Effect.gen(function* () {
        const id = yield* documentId(rawDocumentId).pipe(Effect.mapError(toApplicationError));
        yield* withState(
          purgeDocument(state.catalog, id).pipe(
            Effect.mapError(toApplicationError),
            Effect.flatMap((catalog) => {
              const { [id]: _removedAttachments, ...attachments } = state.attachments;
              return saveState({
                ...state,
                attachments,
                capabilities: state.capabilities.filter(
                  (capability) => capability.documentId !== id,
                ),
                catalog,
              }).pipe(Effect.mapError(toApplicationError));
            }),
          ),
        );
        yield* searchIndex.removeDocument(id).pipe(searchFallback(undefined));
      });

    const purgeDocumentData = (rawDocumentId: string): Effect.Effect<void, ApplicationError> =>
      Effect.gen(function* () {
        const id = yield* documentId(rawDocumentId).pipe(Effect.mapError(toApplicationError));
        yield* releaseDocumentRoom(id);
        const prefix = `workspaces/${state.workspaceId}/documents/${id}/`;
        const keys = yield* objectStore.list(prefix).pipe(Effect.mapError(toApplicationError));
        yield* Effect.forEach(
          keys,
          (key) => objectStore.delete(key).pipe(Effect.mapError(toApplicationError)),
          { concurrency: 16, discard: true },
        );
        yield* journal.delete(id).pipe(Effect.mapError(toApplicationError));
        yield* removeDocumentState(id);
      });

    const afterMutation = (
      room: DocumentAuthorityService,
    ): Effect.Effect<DocumentResponse, ApplicationError> =>
      Effect.gen(function* () {
        yield* projectDocument(room);
        yield* scheduleCheckpoint(room);
        return yield* snapshotFor(room, systemPrincipal);
      });

    const commentActor = (
      principal: Principal,
      guestName: string | undefined,
    ): Effect.Effect<CommentActor, ApplicationError> =>
      Effect.gen(function* () {
        if (principal.kind === "workspace") {
          return {
            displayName: principal.displayName ?? "Workspace user",
            id: principal.personId,
            manageAll: principal.role === "administrator",
          };
        }
        if (principal.kind === "api-key") {
          return {
            displayName: principal.displayName ?? "API key",
            id: principal.personId,
            manageAll: principal.role === "administrator",
          };
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
          (candidate) =>
            candidate.documentId === id &&
            (candidate.status === "active" || candidate.status === "deleted"),
        );
        if (entry === undefined) {
          return yield* applicationFailure("not_found", "The document does not exist.", 404);
        }
        yield* ensurePrivateDocumentState([id]);
        return {
          capabilities: state.capabilities.filter(
            (capability) =>
              capability.documentId === id &&
              (entry.summary?.metadata === undefined ||
                capability.generation === entry.summary.metadata.sharing.generation),
          ),
          documentId: id,
          rfcNumber: entry.rfcNumber,
          summary: entry.summary,
          workspaceId: state.workspaceId,
        };
      });

    const resolvePeople = (
      emails: readonly string[],
    ): Effect.Effect<readonly PersonReference[], ApplicationError> =>
      options.peopleResolver === undefined
        ? Effect.succeed(knownPeopleByEmail(state.catalog, state.authentication, emails))
        : options.peopleResolver(emails);

    const authorsFromEmails = (
      emails: readonly string[],
      metadata: DocumentMetadata,
    ): Effect.Effect<readonly PersonReference[], ApplicationError> =>
      resolvePeople(emails).pipe(
        Effect.flatMap((directoryPeople) =>
          resolveAuthorsByEmail(emails, [
            ...directoryPeople,
            ...metadata.authors,
            ...metadata.reviewers,
            ...metadata.approvers,
          ]),
        ),
        Effect.mapError(toApplicationError),
      );

    const metadataWithResolvedAuthors = (
      metadata: DocumentMetadata,
    ): Effect.Effect<DocumentMetadata, ApplicationError> =>
      authorsFromEmails(
        metadata.authors.map((author) => author.email),
        metadata,
      ).pipe(Effect.map((authors) => ({ ...metadata, authors })));

    const readPublished = (
      rawDocumentId: string,
      canonicalPath: string,
    ): Effect.Effect<PublicDocumentResponse, ApplicationError> =>
      Effect.gen(function* () {
        const room = yield* getRoom(rawDocumentId);
        const current = yield* room
          .snapshot(systemPrincipal, new Date().toISOString())
          .pipe(Effect.mapError(toApplicationError));
        const publishedRevision = current.metadata.publishedRevision;
        if (
          current.metadata.deletedAt !== undefined ||
          current.metadata.personalOwner !== undefined ||
          current.metadata.visibility !== "public" ||
          publishedRevision === undefined
        ) {
          return yield* applicationFailure(
            "not_found",
            "The published document does not exist.",
            404,
          );
        }
        const published = yield* loadPublishedRevision(current.metadata.id, publishedRevision);
        const references = yield* collectReferences(published.body).pipe(
          Effect.mapError(toApplicationError),
        );
        const rendered = yield* renderer
          .render(published.body, {
            numberHeadings: current.metadata.rfcNumber !== undefined,
            protectedLinkHref: ({ index }) =>
              protectedLinkPath(current.metadata.id, publishedRevision, index),
            references: yield* anonymousReferenceResolutions(references),
            unavailableReferenceHref: ({ index }) =>
              referenceLinkPath(current.metadata.id, publishedRevision, index),
          })
          .pipe(Effect.mapError(toApplicationError));
        const metadata = yield* metadataWithResolvedAuthors(published.metadata);
        const publicBody = rewriteProtectedLinkSources(
          redactPublicText(published.body),
          rendered.protectedLinks,
          () => "protected-link",
        );
        return {
          canonicalPath,
          description: excerpt(publicBody),
          headings: rendered.headings,
          html: rendered.html,
          metadata: {
            ...metadata,
            publishedRevision,
          } as DocumentMetadataDto,
        };
      });

    /** The document of a published public RFC, from the catalog alone. */
    const publicRfcDocumentId = (rfcNumber: number): Effect.Effect<string, ApplicationError> => {
      const entry = state.catalog.entries.find(
        (item) =>
          item.status === "active" &&
          (item.rfcNumber === rfcNumber || item.summary?.rfcNumber === rfcNumber) &&
          item.summary?.visibility === "public" &&
          item.summary.publishedRevision !== undefined &&
          item.summary.metadata?.personalOwner === undefined,
      );
      return entry === undefined
        ? applicationFailure("not_found", "The published RFC does not exist.", 404)
        : Effect.succeed(entry.documentId);
    };

    const rebuildSearch: Effect.Effect<SearchRebuildResponse, ApplicationError> = Effect.gen(
      function* () {
        yield* searchIndex.clear.pipe(Effect.mapError(toApplicationError));
        const errors: string[] = [];
        let indexedDocuments = 0;
        for (const entry of state.catalog.entries) {
          if (entry.status !== "active") continue;
          // Open rooms hold the newest state. Otherwise recover read-only from durable
          // storage so a rebuild never writes on behalf of a document authority.
          const open = rooms.get(entry.documentId);
          const indexed = yield* (
            open === undefined
              ? provideAuthorityDependencies(
                  makeDocumentAuthority({
                    documentId: entry.documentId,
                    workspaceId: state.workspaceId,
                  }),
                ).pipe(
                  Effect.flatMap((room) =>
                    room
                      .snapshot(systemPrincipal, new Date().toISOString())
                      .pipe(Effect.ensuring(room.close)),
                  ),
                )
              : open.snapshot(systemPrincipal, new Date().toISOString())
          ).pipe(
            Effect.mapError(toApplicationError),
            Effect.flatMap((snapshot) => indexDocumentVariants(toDocumentResponse(snapshot))),
            Effect.either,
          );
          if (Either.isLeft(indexed)) errors.push(`${entry.documentId}: ${indexed.left.message}`);
          else indexedDocuments += 1;
        }
        return { errors, indexedDocuments };
      },
    );

    const service: InklingApplicationService = {
      authorizeRequest: resolvePrincipal,
      documentRuntimeConfiguration: runtimeConfiguration,
      allDocumentRuntimeConfigurations: () =>
        Effect.suspend(() => {
          const active = state.catalog.entries.filter((entry) => entry.status === "active");
          return ensurePrivateDocumentState(active.map((entry) => entry.documentId)).pipe(
            Effect.zipRight(
              Effect.forEach(active, (entry) => runtimeConfiguration(entry.documentId)),
            ),
          );
        }),
      currentDocumentProjection: (rawDocumentId) =>
        getRoom(rawDocumentId).pipe(Effect.flatMap((room) => snapshotFor(room, systemPrincipal))),
      applyDocumentProjection: (document) =>
        summaryFromDocument(document).pipe(
          Effect.flatMap((summary) =>
            withState(
              applyCatalogSummary(state.catalog, summary).pipe(
                Effect.mapError(toApplicationError),
                Effect.flatMap((catalog) =>
                  saveState({ ...state, catalog }).pipe(Effect.mapError(toApplicationError)),
                ),
              ),
            ),
          ),
          Effect.zipRight(updateSearchIndex(document)),
        ),
      resolvePeople,
      releaseDocumentRoom,
      markCatalogDeleted: (document) =>
        summaryFromDocument(document).pipe(
          Effect.flatMap((summary) =>
            withState(
              applyCatalogSummary(state.catalog, summary).pipe(
                Effect.flatMap((catalog) => tombstoneDocument(catalog, summary.documentId)),
                Effect.mapError(toApplicationError),
                Effect.flatMap((catalog) =>
                  saveState({ ...state, catalog }).pipe(Effect.mapError(toApplicationError)),
                ),
              ),
            ),
          ),
          Effect.zipRight(updateSearchIndex(document)),
        ),
      markCatalogRestored: (document) =>
        summaryFromDocument(document).pipe(
          Effect.flatMap((summary) =>
            withState(
              applyCatalogSummary(state.catalog, summary).pipe(
                Effect.flatMap((catalog) => activateDocument(catalog, summary.documentId)),
                Effect.mapError(toApplicationError),
                Effect.flatMap((catalog) =>
                  saveState({ ...state, catalog }).pipe(Effect.mapError(toApplicationError)),
                ),
              ),
            ),
          ),
          Effect.zipRight(updateSearchIndex(document)),
        ),
      markCatalogPurged: removeDocumentState,
      purgeExpiredDocuments: (now) =>
        Effect.gen(function* () {
          const expired = state.catalog.entries.filter(
            (entry) =>
              entry.status === "deleted" &&
              entry.summary?.metadata !== undefined &&
              isDocumentTrashExpired(entry.summary.metadata, now),
          );
          yield* Effect.forEach(expired, (entry) => purgeDocumentData(entry.documentId), {
            concurrency: 1,
            discard: true,
          });
          return expired.map((entry) => entry.documentId);
        }),
      diagnostics: (credentials) =>
        Effect.gen(function* () {
          const principal = yield* resolvePrincipal(credentials);
          yield* requireAdministrator(principal);
          return {
            activeDocumentRooms: rooms.size,
            dirtyDocuments: checkpointFibers.size,
            generatedAt: new Date().toISOString(),
          };
        }),
      exportWorkspace: (credentials) =>
        Effect.gen(function* () {
          const principal = yield* resolvePrincipal(credentials);
          yield* requireAdministrator(principal);
          yield* ensurePrivateDocumentState(
            state.catalog.entries
              .filter((entry) => entry.status === "active")
              .map((entry) => entry.documentId),
          );
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
          yield* requireAdministrator(principal);
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
          const retainedEntries = state.catalog.entries.filter(
            (entry) => entry.status === "deleted" || entry.status === "purged",
          );
          let rebuilt: WorkspaceCatalogState = {
            entries: retainedEntries,
            nextRfcNumber: Math.max(
              state.catalog.nextRfcNumber,
              ...retainedEntries.map((entry) => (entry.rfcNumber ?? 0) + 1),
            ),
            people: state.catalog.people,
          };
          const errors: string[] = [];
          const recoveredSnapshots: DocumentSnapshot[] = [];
          for (const rawDocumentId of documentIds) {
            if (retainedEntries.some((entry) => entry.documentId === rawDocumentId)) continue;
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
                  .snapshot(systemPrincipal, new Date().toISOString())
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
              creationKey: `${identifierTag.repair}:${rawDocumentId}`,
              documentId: rawDocumentId,
              requestedRfcNumber: snapshot.metadata.rfcNumber,
            }).pipe(Effect.mapError(toApplicationError));
            rebuilt = yield* activateDocument(reserved.state, room.documentId).pipe(
              Effect.flatMap((catalog) =>
                summaryFromSnapshot(snapshot).pipe(
                  Effect.flatMap((summary) => applyCatalogSummary(catalog, summary)),
                ),
              ),
              Effect.mapError(toApplicationError),
            );
            rooms.set(room.documentId, room);
            recoveredSnapshots.push(snapshot);
          }
          if (errors.length === 0) {
            yield* saveState({ ...state, catalog: rebuilt }).pipe(
              Effect.mapError(toApplicationError),
            );
            yield* Effect.forEach(
              recoveredSnapshots,
              (snapshot) => updateSearchIndex(toDocumentResponse(snapshot)),
              { discard: true },
            );
          }
          return { checkedObjects: documentIds.length, errors };
        }),
      restoreWorkspace: (credentials, archive) =>
        Effect.gen(function* () {
          const principal = yield* resolvePrincipal(credentials);
          yield* requireAdministrator(principal);
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
          publishedRevisions.clear();
          // The restored objects hold private document state to mirror again.
          hydratedPrivateState.clear();
          const restored: LocalWorkspaceState = {
            ...decodedState,
            authentication: normalizeAuthenticationState(decodedState.authentication),
            attachments: Object.fromEntries(
              Object.entries(decodedState.attachments ?? {}).map(([documentKey, attachments]) => [
                documentKey,
                attachments as unknown as readonly AttachmentMetadataDto[],
              ]),
            ),
            catalog: normalizeWorkspaceCatalog(decodedState.catalog as WorkspaceCatalogState),
          };
          yield* saveState(restored).pipe(Effect.mapError(toApplicationError));
          yield* rebuildSearch.pipe(
            Effect.tap(({ errors }) =>
              errors.length === 0
                ? Effect.void
                : Effect.logWarning("Search index rebuild after restore was incomplete", errors),
            ),
            Effect.catchAll((error) =>
              Effect.logError("Search index rebuild after restore failed", error.message),
            ),
          );
          return { checkedObjects: objects.length, errors: [] };
        }),
      verifyWorkspace: (credentials) =>
        Effect.gen(function* () {
          const principal = yield* resolvePrincipal(credentials);
          yield* requireAdministrator(principal);
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
          const attachmentId = yield* ids.generate(identifierTag.attachment);
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
                  ? (principal.guestId ?? systemId)
                  : systemId,
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
              room.snapshot(systemPrincipal, attachmentReadAt).pipe(
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
        ).pipe(Effect.zipRight(flushCatalogProjections)),
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
                  Effect.tap(() => scheduleProjection(room)),
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
          const principal = yield* resolvePrincipal(credentials).pipe(
            Effect.catchAll(() => Effect.succeed({ kind: "anonymous" } as const)),
          );
          if (principal.kind === "workspace" || principal.kind === "api-key") {
            const session = state.authentication.sessions.find(
              (candidate) => candidate.personId === principal.personId,
            );
            return {
              authenticated: true,
              principal: {
                displayName: principal.displayName ?? session?.displayName ?? "Workspace user",
                email: session?.email,
                id: principal.personId,
                role: principal.role,
              },
            };
          }
          return { authenticated: false };
        }),
      createApiKey: (credentials, label) =>
        Effect.gen(function* () {
          const principal = yield* resolvePrincipal(credentials);
          const account = yield* requireAccount(principal);
          return yield* withState(
            createApiKey(state.authentication, account, label, new Date().toISOString()).pipe(
              Effect.provideService(IdGenerator, ids),
              Effect.provideService(TokenHasher, tokenHasher),
              Effect.provideService(SecureToken, tokens),
              Effect.mapError(toApplicationError),
              Effect.flatMap((created) =>
                saveState({ ...state, authentication: created.state }).pipe(
                  Effect.mapError(toApplicationError),
                  Effect.as({
                    key: created.token,
                    metadata: apiKeyDto(created.record, account.personId),
                  } satisfies ApiKeyCreated),
                ),
              ),
            ),
          );
        }),
      createAuthorizationCode: (credentials, grant) =>
        Effect.gen(function* () {
          const principal = yield* resolvePrincipal(credentials);
          if (principal.kind !== "workspace") {
            return yield* applicationFailure(
              "forbidden",
              "Approving an application requires a signed-in workspace session.",
              403,
            );
          }
          const account = yield* requireAccount(principal);
          return yield* withState(
            createAuthorizationCode(
              state.authentication,
              account,
              grant,
              new Date().toISOString(),
            ).pipe(
              Effect.provideService(IdGenerator, ids),
              Effect.provideService(TokenHasher, tokenHasher),
              Effect.provideService(SecureToken, tokens),
              Effect.mapError(toApplicationError),
              Effect.flatMap((created) =>
                saveState({ ...state, authentication: created.state }).pipe(
                  Effect.mapError(toApplicationError),
                  Effect.as({ code: created.token, expiresAt: created.expiresAt }),
                ),
              ),
            ),
          );
        }),
      exchangeAuthorizationCode: (code, grant) =>
        withState(
          Effect.gen(function* () {
            const now = new Date().toISOString();
            const taken = takeAuthorizationCode(state.authentication, code, now);
            yield* saveState({ ...state, authentication: taken.state }).pipe(
              Effect.mapError(toApplicationError),
            );
            if (taken.record === undefined || taken.secret === undefined) {
              return yield* applicationFailure(
                "invalid_grant",
                "The authorization code is invalid, expired, or already used.",
                400,
              );
            }
            const record: AuthorizationCodeRecord = taken.record;
            const identity = yield* verifyAuthorizationCode(record, taken.secret, grant, now).pipe(
              Effect.provideService(TokenHasher, tokenHasher),
              Effect.mapError(toApplicationError),
            );
            const created = yield* createApiKey(
              state.authentication,
              identity,
              record.clientName.slice(0, 200),
              now,
              { oauthClientName: record.clientName },
            ).pipe(
              Effect.provideService(IdGenerator, ids),
              Effect.provideService(TokenHasher, tokenHasher),
              Effect.provideService(SecureToken, tokens),
              Effect.mapError(toApplicationError),
            );
            yield* saveState({ ...state, authentication: created.state }).pipe(
              Effect.mapError(toApplicationError),
            );
            return {
              key: created.token,
              metadata: apiKeyDto(created.record, identity.personId),
            } satisfies ApiKeyCreated;
          }),
        ),
      assignRfcNumber: (credentials, rawDocumentId, rfcNumber) =>
        Effect.gen(function* () {
          const room = yield* getRoom(rawDocumentId);
          const principal = yield* resolvePrincipal(credentials, rawDocumentId);
          const metadata = yield* room
            .assignRfcNumber(principal, rfcNumber, new Date().toISOString())
            .pipe(Effect.mapError(toApplicationError));
          yield* projectDocument(room);
          yield* scheduleCheckpoint(room);
          return metadata as DocumentMetadataDto;
        }),
      createDocument: (credentials, request) =>
        Effect.gen(function* () {
          const principal = yield* resolvePrincipal(credentials);
          yield* authorizeWorkspace(principal, "create-document").pipe(
            Effect.mapError(toApplicationError),
          );
          const personalOwner =
            request.personal === true &&
            (principal.kind === "workspace" || principal.kind === "api-key")
              ? principal.personId
              : undefined;
          // Checked before reserving, which would otherwise spend an RFC number.
          if (
            personalOwner !== undefined &&
            (request.allocateRfc === true || request.requestedRfcNumber !== undefined)
          ) {
            return yield* applicationFailure(
              "personal_rfc",
              "Personal documents cannot be RFCs. Create the RFC in the workspace instead.",
              400,
            );
          }
          const now = new Date().toISOString();
          const generatedId = yield* ids.generate(identifierTag.document);
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
          if (reservation.entry.status === "active") {
            const existing = yield* getRoom(reservation.entry.documentId);
            return yield* snapshotFor(existing, principal);
          }
          if (reservation.entry.status === "deleted" || reservation.entry.status === "purged") {
            return yield* applicationFailure(
              "creation_key_retired",
              "This creation key belongs to a deleted document and cannot be reused.",
              409,
            );
          }
          const author =
            principal.kind === "workspace" || principal.kind === "api-key"
              ? workspacePeople(state.catalog, state.authentication).find(
                  (person) => person.id === principal.personId,
                )
              : undefined;
          const metadata = yield* createDocumentMetadata(
            {
              authors: author === undefined ? [] : [author],
              id: reservation.entry.documentId,
              personalOwner,
              rfcNumber: reservation.entry.rfcNumber,
              title: documentTitleFromMarkdown(request.body ?? "") ?? request.title,
            },
            now,
          ).pipe(Effect.mapError(toApplicationError));
          const room = yield* provideAuthorityDependencies(
            makeDocumentAuthority({
              documentId: reservation.entry.documentId,
              initialBody: withMetadataFrontmatter(request.body ?? "", metadata),
              initialMetadata: metadata,
              workspaceId: state.workspaceId,
            }),
          ).pipe(Effect.mapError(toApplicationError));
          rooms.set(room.documentId, room);
          yield* room.checkpoint(now).pipe(Effect.mapError(toApplicationError));
          const snapshot = yield* room
            .snapshot(systemPrincipal, now)
            .pipe(Effect.mapError(toApplicationError));
          yield* withState(
            activateDocument(state.catalog, room.documentId).pipe(
              Effect.flatMap((catalog) =>
                summaryFromSnapshot(snapshot).pipe(
                  Effect.flatMap((summary) => applyCatalogSummary(catalog, summary)),
                ),
              ),
              Effect.mapError(toApplicationError),
              Effect.flatMap((catalog) =>
                saveState({ ...state, catalog }).pipe(Effect.mapError(toApplicationError)),
              ),
            ),
          );
          yield* updateSearchIndex(toDocumentResponse(snapshot));
          return toDocumentResponse(snapshot);
        }),
      importDocument: (credentials, request: ImportDocumentRequest) =>
        Effect.gen(function* () {
          const principal = yield* resolvePrincipal(credentials);
          yield* requireAdministrator(principal);
          if (request.publish === true) {
            yield* renderer.render(request.body).pipe(Effect.mapError(toApplicationError));
          }
          const generatedId = yield* ids.generate(identifierTag.document);
          const importedId = request.metadata.id ?? generatedId;
          const reservation = yield* withState(
            reserveDocument(state.catalog, {
              allocateRfc: false,
              creationKey: `${identifierTag.import}:${importedId}`,
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
            return yield* snapshotFor(existing, systemPrincipal);
          }
          if (reservation.entry.status === "deleted" || reservation.entry.status === "purged") {
            return yield* applicationFailure(
              "creation_key_retired",
              "This import belongs to a deleted document and cannot be reused.",
              409,
            );
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
              targetDecisionDate: request.metadata.targetDecisionDate,
              title: documentTitleFromMarkdown(request.body) ?? request.metadata.title,
              visibility: request.metadata.visibility,
            },
            importedAt,
          ).pipe(Effect.mapError(toApplicationError));
          const room = yield* provideAuthorityDependencies(
            makeDocumentAuthority({
              documentId: reservation.entry.documentId,
              initialBody: withMetadataFrontmatter(request.body, metadata),
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
            const threadId = yield* ids.generate(identifierTag.commentThread);
            const rootId = yield* ids.generate(identifierTag.commentMessage);
            const actor: CommentActor = {
              displayName: root.authorDisplayName,
              id: systemId,
              manageAll: true,
            };
            yield* room
              .createThreadAtOffsets(
                systemPrincipal,
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
              const messageId = yield* ids.generate(identifierTag.commentMessage);
              const parentId =
                (importedMessage.parentLegacyId === undefined
                  ? undefined
                  : messageIds.get(importedMessage.parentLegacyId)) ?? lastMessageId;
              yield* room
                .reply(
                  systemPrincipal,
                  threadId,
                  messageId,
                  parentId,
                  importedMessage.body,
                  {
                    displayName: importedMessage.authorDisplayName,
                    id: systemId,
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
                .setThreadResolution(systemPrincipal, threadId, true, importedAt)
                .pipe(Effect.mapError(toApplicationError));
            }
          }
          yield* room.checkpoint(importedAt).pipe(Effect.mapError(toApplicationError));
          if (request.publish === true) {
            yield* room
              .publish(systemPrincipal, importedAt)
              .pipe(Effect.mapError(toApplicationError));
            const published = yield* room
              .snapshot(systemPrincipal, importedAt)
              .pipe(Effect.mapError(toApplicationError));
            yield* writePublishedArtifact(
              state.workspaceId,
              published,
              renderer,
              objectStore,
              digest,
              anonymousReferenceResolutions,
            ).pipe(Effect.ignore);
            yield* room.checkpoint(importedAt).pipe(Effect.mapError(toApplicationError));
          }
          const snapshot = yield* room
            .snapshot(systemPrincipal, importedAt)
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
                summaryFromSnapshot(snapshot).pipe(
                  Effect.flatMap((summary) => applyCatalogSummary(catalog, summary)),
                ),
              ),
              Effect.map((catalog) => directoryEntries.reduce(upsertPerson, catalog)),
              Effect.mapError(toApplicationError),
              Effect.flatMap((catalog) =>
                saveState({ ...state, catalog }).pipe(Effect.mapError(toApplicationError)),
              ),
            ),
          );
          yield* updateSearchIndex(toDocumentResponse(snapshot));
          return toDocumentResponse(snapshot);
        }),
      createThread: (credentials, rawDocumentId, request) =>
        Effect.gen(function* () {
          const room = yield* getRoom(rawDocumentId);
          const principal = yield* resolvePrincipal(credentials, rawDocumentId);
          const actor = yield* commentActor(principal, request.authorDisplayName);
          const threadId = yield* ids.generate(identifierTag.commentThread);
          const messageId = yield* ids.generate(identifierTag.commentMessage);
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
          const now = new Date().toISOString();
          yield* room
            .deleteDocument(principal, expectedRevision, now)
            .pipe(Effect.mapError(toApplicationError));
          yield* projectDocumentStatus(room, "deleted");
          yield* room.checkpoint(now).pipe(Effect.mapError(toApplicationError));
        }),
      restoreDocument: (credentials, rawDocumentId, expectedRevision) =>
        Effect.gen(function* () {
          const room = yield* getRoom(rawDocumentId);
          const principal = yield* resolvePrincipal(credentials, rawDocumentId);
          const now = new Date().toISOString();
          const metadata = yield* room
            .restoreDocument(principal, expectedRevision, now)
            .pipe(Effect.mapError(toApplicationError));
          yield* projectDocumentStatus(room, "active");
          yield* room.checkpoint(now).pipe(Effect.mapError(toApplicationError));
          return metadata as DocumentMetadataDto;
        }),
      sharePersonalDocument: (credentials, rawDocumentId, request) =>
        Effect.gen(function* () {
          const room = yield* getRoom(rawDocumentId);
          const principal = yield* resolvePrincipal(credentials, rawDocumentId);
          const now = new Date().toISOString();
          const current = yield* room
            .snapshot(principal, now)
            .pipe(Effect.mapError(toApplicationError));
          const directoryPeople = yield* resolvePeople(request.emails);
          const people = yield* resolveAuthorsByEmail(request.emails, [
            ...directoryPeople,
            ...(current.metadata.sharedWith ?? []),
          ]).pipe(Effect.mapError(toApplicationError));
          const metadata = yield* room
            .sharePersonalDocument(principal, people, request.expectedRevision, now)
            .pipe(Effect.mapError(toApplicationError));
          yield* projectDocument(room);
          // Access changed, so the change is durable before anyone relies on it.
          yield* room.checkpoint(now).pipe(Effect.mapError(toApplicationError));
          return metadata as DocumentMetadataDto;
        }),
      moveToWorkspace: (credentials, rawDocumentId, expectedRevision) =>
        Effect.gen(function* () {
          const room = yield* getRoom(rawDocumentId);
          const principal = yield* resolvePrincipal(credentials, rawDocumentId);
          const now = new Date().toISOString();
          const metadata = yield* room
            .moveToWorkspace(principal, expectedRevision, now)
            .pipe(Effect.mapError(toApplicationError));
          yield* projectDocument(room);
          // Access widened, so the change is durable before anyone relies on it.
          yield* room.checkpoint(now).pipe(Effect.mapError(toApplicationError));
          return metadata as DocumentMetadataDto;
        }),
      hardDeleteDocument: (credentials, rawDocumentId, expectedRevision) =>
        Effect.gen(function* () {
          const id = yield* documentId(rawDocumentId).pipe(Effect.mapError(toApplicationError));
          const principal = yield* resolvePrincipal(credentials, rawDocumentId);
          // Administrators purge workspace documents; owners purge their personal ones.
          // Either way the document's metadata authorizes the purge below.
          yield* requireAccount(principal);
          const entry = state.catalog.entries.find((candidate) => candidate.documentId === id);
          if (entry === undefined || entry.status === "purged") return;
          if (entry.status !== "deleted") {
            return yield* applicationFailure(
              "document_not_deleted",
              "Only documents in the trash can be permanently deleted.",
              409,
            );
          }
          const metadata =
            entry.summary?.metadata ??
            (yield* getRoom(rawDocumentId).pipe(
              Effect.flatMap((room) => room.snapshot(systemPrincipal, new Date().toISOString())),
              Effect.mapError(toApplicationError),
              Effect.map((snapshot) => snapshot.metadata),
            ));
          yield* authorizeDocument(
            principal,
            "hard-delete",
            metadata,
            new Date().toISOString(),
          ).pipe(Effect.mapError(toApplicationError));
          yield* requireRevision(metadata, expectedRevision).pipe(
            Effect.mapError(toApplicationError),
          );
          yield* purgeDocumentData(id);
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
          const principal = yield* resolvePrincipal(credentials);
          const account = yield* requireAccount(principal);
          return state.authentication.apiKeys
            .filter((record) => apiKeyBelongsTo(record, account.personId))
            .map((record) => apiKeyDto(record, account.personId));
        }),
      revealApiKey: (credentials, keyId) =>
        Effect.gen(function* () {
          const principal = yield* resolvePrincipal(credentials);
          const account = yield* requireAccount(principal);
          const record = state.authentication.apiKeys.find(
            (candidate) =>
              candidate.id === keyId &&
              candidate.revokedAt === undefined &&
              apiKeyBelongsTo(candidate, account.personId),
          );
          if (record === undefined) {
            return yield* applicationFailure("not_found", "The API key does not exist.", 404);
          }
          if (record.retainedSecret === undefined) {
            return yield* applicationFailure(
              "api_key_not_revealable",
              "This older API key cannot be revealed. Create a replacement key to reuse access.",
              409,
            );
          }
          return {
            key: `${record.id}.${record.retainedSecret}`,
            metadata: apiKeyDto(record, account.personId),
          } satisfies ApiKeyCreated;
        }),
      listPublicDocuments: (query, lifecycleState, label) =>
        Effect.gen(function* () {
          yield* flushPendingProjections;
          const normalizedQuery = normalizeSearchText(query);
          const bodyMatches =
            normalizedQuery.length === 0
              ? new Set<DocumentId>()
              : yield* searchIndex
                  .matchDocuments({ match: "all", phrases: [normalizedQuery] }, "published")
                  .pipe(searchFallback(new Set<DocumentId>()));
          const metadataMatches = (metadata: {
            readonly labels: readonly string[];
            readonly rfcNumber?: number | undefined;
            readonly title: string;
          }): boolean =>
            normalizeSearchText(
              `${metadata.rfcNumber ?? ""} ${metadata.title} ${metadata.labels.join(" ")}`,
            ).includes(normalizedQuery);
          // Only candidates are loaded from storage; the published revision decides the match.
          const entries = publicCatalog(state.catalog).filter(
            (summary) =>
              normalizedQuery.length === 0 ||
              bodyMatches.has(summary.documentId) ||
              metadataMatches(summary),
          );
          const documents = yield* Effect.forEach(
            entries,
            (summary) => {
              const publishedRevision = summary.publishedRevision;
              if (publishedRevision === undefined) return Effect.succeed(undefined);
              return loadPublishedRevision(summary.documentId, publishedRevision).pipe(
                Effect.flatMap((snapshot) =>
                  metadataWithResolvedAuthors(snapshot.metadata).pipe(
                    Effect.map((metadata) => {
                      const publicBody = redactPublicText(snapshot.body);
                      return (normalizedQuery.length === 0 ||
                        bodyMatches.has(summary.documentId) ||
                        metadataMatches(metadata)) &&
                        (lifecycleState === undefined ||
                          metadata.lifecycleState === lifecycleState) &&
                        (label === undefined || metadata.labels.includes(label))
                        ? {
                            excerpt: excerpt(publicBody),
                            metadata: {
                              ...metadata,
                              publishedRevision,
                            } as DocumentMetadataDto,
                          }
                        : undefined;
                    }),
                  ),
                ),
              );
            },
            { concurrency: 8 },
          );
          return {
            documents: documents.filter(
              (document): document is Exclude<typeof document, undefined> => document !== undefined,
            ),
          } satisfies CatalogResponse;
        }),
      listDocuments: (credentials, query) =>
        Effect.gen(function* () {
          yield* flushPendingProjections;
          const principal = yield* resolvePrincipal(credentials);
          yield* authorizeWorkspace(principal, "read-catalog").pipe(
            Effect.mapError(toApplicationError),
          );
          const parsed = parseCatalogSearchQuery(query);
          const freeTerms = [
            ...new Set(
              parsed.terms.flatMap((term) => (term.field === undefined ? [term.value] : [])),
            ),
          ];
          const bodyMatches = new Map(
            yield* Effect.forEach(freeTerms, (term) =>
              searchIndex.matchDocuments({ match: "all", phrases: [term] }, "working").pipe(
                searchFallback(new Set<DocumentId>()),
                Effect.map((documentIds) => [term, documentIds] as const),
              ),
            ),
          );
          const now = new Date().toISOString();
          const summaries = searchCatalog(state.catalog, query, {
            bodyMatches,
            currentPersonId:
              principal.kind === "workspace" || principal.kind === "api-key"
                ? principal.personId
                : undefined,
            visible: (summary) => mayDiscover(principal, summary, now),
          });
          const positiveTerms = parsed.terms.flatMap((term) =>
            term.field === undefined && !term.negated ? [term.value] : [],
          );
          const excerpts =
            positiveTerms.length === 0
              ? new Map<DocumentId, string>()
              : yield* searchIndex
                  .excerpts(
                    { match: "any", phrases: positiveTerms },
                    "working",
                    summaries
                      .filter((summary) =>
                        positiveTerms.some((term) =>
                          bodyMatches.get(term)?.has(summary.documentId),
                        ),
                      )
                      .map((summary) => summary.documentId),
                  )
                  .pipe(searchFallback(new Map<DocumentId, string>()));
          const documents = yield* Effect.forEach(summaries, (summary) =>
            summary.metadata === undefined
              ? getRoom(summary.documentId).pipe(
                  Effect.flatMap((room) => room.snapshot(systemPrincipal, now)),
                  Effect.mapError(toApplicationError),
                  // Summaries without metadata predate personal documents, but
                  // the authoritative metadata decides all the same.
                  Effect.map((snapshot) =>
                    isDocumentActionAllowed(principal, "discover", snapshot.metadata, now)
                      ? [
                          {
                            excerpt: excerpts.get(summary.documentId) ?? summary.excerpt,
                            metadata: snapshot.metadata as DocumentMetadataDto,
                          },
                        ]
                      : [],
                  ),
                )
              : Effect.succeed([
                  {
                    excerpt: excerpts.get(summary.documentId) ?? summary.excerpt,
                    metadata: {
                      ...summary.metadata,
                      labels: summary.workingLabels ?? summary.metadata.labels,
                    } as DocumentMetadataDto,
                  },
                ]),
          );
          return {
            documents: documents.flat(),
            people: workspacePeople(state.catalog, state.authentication).map(
              (person) => person as DocumentMetadataDto["authors"][number],
            ),
          } satisfies CatalogResponse;
        }),
      searchPassages: (credentials, query, limit) =>
        Effect.gen(function* () {
          yield* flushPendingProjections;
          const principal = yield* resolvePrincipal(credentials);
          yield* authorizeWorkspace(principal, "read-catalog").pipe(
            Effect.mapError(toApplicationError),
          );
          const parsed = parseCatalogSearchQuery(query);
          const positiveTerms = [
            ...new Set(
              parsed.terms.flatMap((term) =>
                term.field === undefined && !term.negated ? [term.value] : [],
              ),
            ),
          ];
          if (positiveTerms.length === 0) {
            return yield* applicationFailure(
              "search_terms_required",
              "Passage search needs at least one search term besides filters.",
              400,
            );
          }
          const negatedTerms = parsed.terms.flatMap((term) =>
            term.field === undefined && term.negated ? [term.value] : [],
          );
          const excluded = new Set<DocumentId>();
          for (const term of negatedTerms) {
            const matches = yield* searchIndex
              .matchDocuments({ match: "all", phrases: [term] }, "working")
              .pipe(Effect.mapError(toApplicationError));
            for (const matched of matches) excluded.add(matched);
          }
          const now = new Date().toISOString();
          const currentPersonId =
            principal.kind === "workspace" || principal.kind === "api-key"
              ? principal.personId
              : undefined;
          // Authorization happens here, against structured metadata, before anything surfaces.
          const readable = filterCatalog(state.catalog, parsed, {
            currentPersonId,
            visible: (summary) => mayDiscover(principal, summary, now),
          }).filter(
            (summary) =>
              summary.metadata !== undefined &&
              isDocumentActionAllowed(principal, "read-working", summary.metadata, now) &&
              !excluded.has(summary.documentId) &&
              !negatedTerms.some((term) => normalizeSearchText(summary.title).includes(term)),
          );
          const readableById = new Map(readable.map((summary) => [summary.documentId, summary]));
          const activeDocuments = state.catalog.entries.filter(
            (entry) => entry.status === "active",
          ).length;
          const passages = yield* searchIndex
            .searchPassages({
              documentIds:
                readable.length === activeDocuments
                  ? undefined
                  : readable.map((summary) => summary.documentId),
              keyword: { match: "any", phrases: positiveTerms },
              limit: Math.max(1, Math.min(limit ?? 10, 50)),
              perDocumentLimit: 3,
              semantic: positiveTerms.join(" "),
              variant: "working",
            })
            .pipe(Effect.mapError(toApplicationError));
          return {
            passages: passages.flatMap((passage): readonly SearchPassageDto[] => {
              const summary = readableById.get(passage.documentId);
              if (summary === undefined) return [];
              return [
                {
                  documentId: passage.documentId,
                  endLine: passage.endLine,
                  headingPath: passage.headingPath,
                  matchedBy: passage.matchedBy,
                  revision: passage.revision,
                  ...(summary.rfcNumber === undefined ? {} : { rfcNumber: summary.rfcNumber }),
                  score: passage.score,
                  snippet: passage.snippet,
                  startLine: passage.startLine,
                  title: summary.title,
                },
              ];
            }),
            semantic: searchIndex.semantic,
          } satisfies PassageSearchResponse;
        }),
      rebuildSearchIndex: (credentials) =>
        resolvePrincipal(credentials).pipe(
          Effect.flatMap(requireAdministrator),
          Effect.zipRight(rebuildSearch),
        ),
      refreshSearchIndex: () =>
        searchIndex.refresh(Date.now() - 10_000).pipe(
          Effect.map((result) => result.pending),
          Effect.mapError(toApplicationError),
        ),
      listDeletedDocuments: (credentials) =>
        Effect.gen(function* () {
          yield* flushPendingProjections;
          const principal = yield* resolvePrincipal(credentials);
          // Administrators see every workspace document in the trash; everyone
          // sees the personal documents they trashed themselves.
          yield* requireAccount(principal);
          const now = new Date().toISOString();
          const summaries = searchCatalog(state.catalog, "", {
            limit: 500,
            onlyDeleted: true,
            visible: (summary) =>
              summary.metadata === undefined
                ? isAdministrator(principal)
                : isDocumentActionAllowed(principal, "restore", summary.metadata, now),
          });
          const documents = yield* Effect.forEach(summaries, (summary) =>
            summary.metadata === undefined
              ? getRoom(summary.documentId).pipe(
                  Effect.flatMap((room) => room.snapshot(systemPrincipal, now)),
                  Effect.mapError(toApplicationError),
                  Effect.map((snapshot) =>
                    isDocumentActionAllowed(principal, "restore", snapshot.metadata, now)
                      ? [
                          {
                            excerpt: summary.excerpt,
                            metadata: snapshot.metadata as DocumentMetadataDto,
                          },
                        ]
                      : [],
                  ),
                )
              : Effect.succeed([
                  {
                    excerpt: summary.excerpt,
                    metadata: summary.metadata as DocumentMetadataDto,
                  },
                ]),
          );
          return { documents: documents.flat() } satisfies CatalogResponse;
        }),
      loginWorkspaceIdentity: (identity, directoryPeople = []) =>
        withState(
          createWorkspaceSession(state.authentication, identity, new Date().toISOString()).pipe(
            Effect.provideService(IdGenerator, ids),
            Effect.provideService(TokenHasher, tokenHasher),
            Effect.provideService(SecureToken, tokens),
            Effect.mapError(toApplicationError),
            Effect.flatMap((created) => {
              const directoryCatalog = directoryPeople.reduce(upsertPerson, state.catalog);
              const existing = directoryCatalog.people.find(
                (entry) => entry.person.id === identity.personId,
              );
              const catalog = upsertPerson(directoryCatalog, {
                aliases: existing?.aliases ?? [],
                person: {
                  displayName: identity.displayName,
                  email: identity.email.toLocaleLowerCase("en"),
                  id: identity.personId,
                },
              });
              return tokens.generate(24).pipe(
                Effect.mapError(toApplicationError),
                Effect.flatMap((csrfToken) =>
                  saveState({ ...state, authentication: created.state, catalog }).pipe(
                    Effect.mapError(toApplicationError),
                    Effect.as({
                      csrfToken,
                      expiresAt: created.expiresAt,
                      sessionToken: created.token,
                    }),
                  ),
                ),
              );
            }),
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
          const now = new Date().toISOString();
          const current = yield* room
            .snapshot(principal, now)
            .pipe(Effect.mapError(toApplicationError));
          const source = yield* parseDocumentSource(current.body).pipe(
            Effect.mapError(toApplicationError),
          );
          if (documentTitleFromMarkdown(current.body) === undefined) {
            return yield* applicationFailure(
              "title_required",
              "Add a top-level Markdown heading before publishing.",
              400,
            );
          }
          yield* renderer.render(current.body).pipe(Effect.mapError(toApplicationError));
          if (source.frontmatter !== undefined) {
            const frontmatter = source.frontmatter;
            yield* room
              .updateMetadata(
                principal,
                {
                  authors:
                    frontmatter.authors === undefined
                      ? undefined
                      : yield* authorsFromEmails(frontmatter.authors, current.metadata),
                  labels: frontmatter.labels,
                  lifecycleState: frontmatter.state,
                  visibility: frontmatter.visibility,
                },
                current.metadata.headRevision,
                now,
              )
              .pipe(Effect.mapError(toApplicationError));
          }
          const metadata = yield* room
            .publish(principal, now)
            .pipe(Effect.mapError(toApplicationError));
          const published = yield* room
            .snapshot(systemPrincipal, new Date().toISOString())
            .pipe(Effect.mapError(toApplicationError));
          yield* writePublishedArtifact(
            state.workspaceId,
            published,
            renderer,
            objectStore,
            digest,
            anonymousReferenceResolutions,
          ).pipe(Effect.ignore);
          yield* projectDocument(room);
          yield* scheduleCheckpoint(room);
          return metadata as DocumentMetadataDto;
        }),
      listDocumentHistory: (credentials, rawDocumentId) =>
        Effect.gen(function* () {
          const room = yield* getRoom(rawDocumentId);
          const principal = yield* resolvePrincipal(credentials, rawDocumentId);
          const now = new Date().toISOString();
          const current = yield* room
            .snapshot(principal, now)
            .pipe(Effect.mapError(toApplicationError));
          yield* authorizeDocument(principal, "read-history", current.metadata, now).pipe(
            Effect.mapError(toApplicationError),
          );
          yield* room.checkpoint(now).pipe(Effect.mapError(toApplicationError));
          const history = yield* provideAuthorityDependencies(
            readDocumentHistory({ documentId: room.documentId, workspaceId: state.workspaceId }),
          ).pipe(Effect.mapError(toApplicationError));
          return {
            versions: [
              {
                kind: "snapshot" as const,
                occurredAt: history.baseline.occurredAt,
                revision: history.baseline.revision,
                sequence: history.baseline.sequence,
              },
              ...history.events.map((event) => ({
                actor: event.actor,
                kind: event.kind,
                occurredAt: event.occurredAt,
                revision: event.revision,
                sequence: event.sequence,
                source: event.source,
              })),
            ],
          } satisfies DocumentHistoryResponse;
        }),
      readDocument: (credentials, rawDocumentId, startLine, endLine, published = false) =>
        Effect.gen(function* () {
          const room = yield* getRoom(rawDocumentId);
          const principal = yield* resolvePrincipal(credentials, rawDocumentId);
          const read = published
            ? publishedSnapshotFor(room, principal, startLine, endLine)
            : snapshotFor(room, principal, startLine, endLine);
          return yield* read;
        }),
      readDocumentHistoryRevision: (credentials, rawDocumentId, rawRevision) =>
        Effect.gen(function* () {
          const room = yield* getRoom(rawDocumentId);
          const principal = yield* resolvePrincipal(credentials, rawDocumentId);
          const revision = yield* documentRevision(rawRevision).pipe(
            Effect.mapError(toApplicationError),
          );
          const now = new Date().toISOString();
          const current = yield* room
            .snapshot(principal, now)
            .pipe(Effect.mapError(toApplicationError));
          yield* authorizeDocument(principal, "read-history", current.metadata, now).pipe(
            Effect.mapError(toApplicationError),
          );
          yield* room.checkpoint(now).pipe(Effect.mapError(toApplicationError));
          const historical = yield* provideAuthorityDependencies(
            loadDocumentHistoryRevision(
              { documentId: room.documentId, workspaceId: state.workspaceId },
              revision,
            ),
          ).pipe(Effect.mapError(toApplicationError));
          return toDocumentResponse(historical);
        }),
      readPublicDocument: (rawDocumentId) =>
        readPublished(rawDocumentId, `/public/documents/${encodeURIComponent(rawDocumentId)}`),
      readPublicRfc: (rfcNumber) =>
        publicRfcDocumentId(rfcNumber).pipe(
          Effect.flatMap((id) => readPublished(id, canonicalRfcPath(rfcNumber))),
        ),
      publicRfcRuntimeConfiguration: (rfcNumber) =>
        publicRfcDocumentId(rfcNumber).pipe(Effect.flatMap(runtimeConfiguration)),
      resolveReferences: (credentials, references) =>
        Effect.gen(function* () {
          if (references.length > maximumReferencesPerRequest) {
            return yield* applicationFailure(
              "too_many_references",
              `Resolve at most ${maximumReferencesPerRequest} references at once.`,
              400,
            );
          }
          if (options.referenceResolver !== undefined) {
            return yield* options.referenceResolver(credentials, references);
          }
          // A share link opens one document; across documents its holder
          // reads like anyone else, or as the account they are signed in to.
          const principal = yield* resolvePrincipal({
            bearerToken: credentials.bearerToken,
            internalPrincipal: credentials.internalPrincipal,
            sessionToken: credentials.sessionToken,
          });
          return yield* resolveReferencesFor(principal, references);
        }),
      resolveReferenceLink: (credentials, rawDocumentId, rawRevision, referenceIndex) =>
        Effect.gen(function* () {
          const id = yield* documentId(rawDocumentId).pipe(Effect.mapError(toApplicationError));
          const principal = yield* resolvePrincipal(credentials, id);
          yield* requireAccount(principal);
          const revision = yield* documentRevision(rawRevision).pipe(
            Effect.mapError(toApplicationError),
          );
          const published = yield* loadPublishedRevision(id, revision);
          const references = yield* collectReferences(published.body).pipe(
            Effect.mapError(toApplicationError),
          );
          const reference = references[referenceIndex];
          return reference === undefined
            ? yield* applicationFailure("not_found", "The reference does not exist.", 404)
            : referenceDestination(reference);
        }),
      resolveProtectedLink: (credentials, rawDocumentId, rawRevision, linkIndex) =>
        Effect.gen(function* () {
          const id = yield* documentId(rawDocumentId).pipe(Effect.mapError(toApplicationError));
          const principal = yield* resolvePrincipal(credentials, id);
          yield* requireAccount(principal);
          const revision = yield* documentRevision(rawRevision).pipe(
            Effect.mapError(toApplicationError),
          );
          const published = yield* loadPublishedRevision(id, revision);
          const rendered = yield* renderer
            .render(published.body)
            .pipe(Effect.mapError(toApplicationError));
          const link = rendered.protectedLinks[linkIndex];
          return link === undefined
            ? yield* applicationFailure("not_found", "The protected link does not exist.", 404)
            : link.destination;
        }),
      reserveRfcNumber: (credentials, rawDocumentId) =>
        Effect.gen(function* () {
          const principal = yield* resolvePrincipal(credentials);
          yield* authorizeWorkspace(principal, "create-document").pipe(
            Effect.mapError(toApplicationError),
          );
          // The document authority refuses RFC numbers for personal documents
          // too; refusing here keeps the workspace from spending one on them.
          const metadata = state.catalog.entries.find((entry) => entry.documentId === rawDocumentId)
            ?.summary?.metadata;
          if (metadata?.personalOwner !== undefined) {
            yield* authorizeDocument(
              principal,
              "edit-metadata",
              metadata,
              new Date().toISOString(),
            ).pipe(Effect.mapError(toApplicationError));
            return yield* applicationFailure(
              "personal_rfc",
              "Personal documents cannot be RFCs. Move the document to the workspace first.",
              409,
            );
          }
          return yield* withState(
            allocateRfcNumber(state.catalog, rawDocumentId).pipe(
              Effect.mapError(toApplicationError),
              Effect.tap(({ state: catalog }) =>
                saveState({ ...state, catalog }).pipe(Effect.mapError(toApplicationError)),
              ),
              Effect.map((allocation) => allocation.rfcNumber),
            ),
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
          const messageId = yield* ids.generate(identifierTag.commentMessage);
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
      restoreDocumentHistoryRevision: (credentials, rawDocumentId, rawRevision, expectedRevision) =>
        Effect.gen(function* () {
          const room = yield* getRoom(rawDocumentId);
          const principal = yield* resolvePrincipal(credentials, rawDocumentId);
          const revision = yield* documentRevision(rawRevision).pipe(
            Effect.mapError(toApplicationError),
          );
          const now = new Date().toISOString();
          const current = yield* room
            .snapshot(principal, now)
            .pipe(Effect.mapError(toApplicationError));
          yield* authorizeDocument(principal, "restore-history", current.metadata, now).pipe(
            Effect.mapError(toApplicationError),
          );
          yield* requireRevision(current.metadata, expectedRevision).pipe(
            Effect.mapError(toApplicationError),
          );
          yield* room.checkpoint(now).pipe(Effect.mapError(toApplicationError));
          const historical = yield* provideAuthorityDependencies(
            loadDocumentHistoryRevision(
              { documentId: room.documentId, workspaceId: state.workspaceId },
              revision,
            ),
          ).pipe(Effect.mapError(toApplicationError));
          yield* room
            .replaceBody(principal, historical.body, expectedRevision, now)
            .pipe(Effect.mapError(toApplicationError));
          return yield* afterMutation(room);
        }),
      revokeApiKey: (credentials, keyId) =>
        Effect.gen(function* () {
          const principal = yield* resolvePrincipal(credentials);
          const account = yield* requireAccount(principal);
          yield* withState(
            revokeApiKey(
              state.authentication,
              keyId,
              account.personId,
              new Date().toISOString(),
            ).pipe(
              Effect.mapError(toApplicationError),
              Effect.flatMap((authentication) =>
                saveState({ ...state, authentication }).pipe(Effect.mapError(toApplicationError)),
              ),
            ),
          );
        }),
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
            .updateMetadata(principal, patch, request.expectedRevision, new Date().toISOString())
            .pipe(Effect.mapError(toApplicationError));
          yield* projectDocument(room);
          yield* scheduleCheckpoint(room);
          return metadata as DocumentMetadataDto;
        }),
      listShareLinks: (credentials, rawDocumentId, baseUrl) =>
        Effect.gen(function* () {
          const room = yield* getRoom(rawDocumentId);
          const principal = yield* resolvePrincipal(credentials, rawDocumentId);
          const now = new Date().toISOString();
          const snapshot = yield* room
            .snapshot(principal, now)
            .pipe(Effect.mapError(toApplicationError));
          yield* authorizeDocument(principal, "manage-sharing", snapshot.metadata, now).pipe(
            Effect.mapError(toApplicationError),
          );
          return yield* withState(
            Effect.succeed(
              shareLinksResponse(
                snapshot.metadata,
                state.capabilities.filter(
                  (capability) =>
                    capability.documentId === room.documentId &&
                    capability.generation === snapshot.metadata.sharing.generation,
                ),
                baseUrl,
              ),
            ),
          );
        }),
      createShareLink: (credentials, rawDocumentId, request, baseUrl) =>
        Effect.gen(function* () {
          const room = yield* getRoom(rawDocumentId);
          const principal = yield* resolvePrincipal(credentials, rawDocumentId);
          const now = new Date().toISOString();
          const snapshot = yield* room
            .snapshot(principal, now)
            .pipe(Effect.mapError(toApplicationError));
          yield* authorizeDocument(principal, "manage-sharing", snapshot.metadata, now).pipe(
            Effect.mapError(toApplicationError),
          );
          const existing = yield* withState(
            Effect.succeed(
              state.capabilities.filter(
                (capability) =>
                  capability.documentId === room.documentId &&
                  capability.generation === snapshot.metadata.sharing.generation,
              ),
            ),
          );
          if (existing.some((capability) => sameShareConfiguration(capability, request))) {
            return yield* applicationFailure(
              "share_configuration_exists",
              "A share link with this access and protection already exists.",
              409,
            );
          }

          const id = yield* ids.generate(identifierTag.capability);
          const secret = yield* tokens.generate(32).pipe(Effect.mapError(toApplicationError));
          const tokenHash = yield* tokenHasher
            .hash(secret)
            .pipe(Effect.mapError(toApplicationError));
          const passwordHash =
            request.password === undefined
              ? undefined
              : yield* hasher.hash(request.password).pipe(Effect.mapError(toApplicationError));
          const passwordProof =
            request.password === undefined
              ? undefined
              : yield* tokens.generate(32).pipe(Effect.mapError(toApplicationError));
          const access = strongestCapabilityAccess([...existing, { access: request.access }]);
          const metadata = yield* room
            .updateSharing(principal, access, request.expectedRevision, now)
            .pipe(Effect.mapError(toApplicationError));
          const capability: CapabilityRecord = {
            access: request.access,
            createdAt: now,
            documentId: room.documentId,
            expiresAt: request.expiresAt,
            generation: metadata.sharing.generation,
            id,
            passwordHash,
            passwordProof,
            retainedSecret: secret,
            tokenHash,
          };
          const result = yield* withState(
            Effect.gen(function* () {
              const documentCapabilities = [...existing, capability].map((item) =>
                capabilityWithGeneration(item, metadata.sharing.generation),
              );
              const capabilities = [
                ...state.capabilities.filter((item) => item.documentId !== room.documentId),
                ...documentCapabilities,
              ];
              yield* saveState({ ...state, capabilities }).pipe(
                Effect.mapError(toApplicationError),
              );
              yield* persistPrivateDocumentState(state, room.documentId, objectStore, digest).pipe(
                Effect.mapError(toApplicationError),
              );
              return shareLinksResponse(metadata, documentCapabilities, baseUrl);
            }),
          );
          yield* projectDocument(room);
          yield* scheduleCheckpoint(room);
          return result;
        }),
      deleteShareLink: (credentials, rawDocumentId, shareId, expectedRevision, baseUrl) =>
        Effect.gen(function* () {
          const room = yield* getRoom(rawDocumentId);
          const principal = yield* resolvePrincipal(credentials, rawDocumentId);
          const now = new Date().toISOString();
          const snapshot = yield* room
            .snapshot(principal, now)
            .pipe(Effect.mapError(toApplicationError));
          yield* authorizeDocument(principal, "manage-sharing", snapshot.metadata, now).pipe(
            Effect.mapError(toApplicationError),
          );
          const existing = yield* withState(
            Effect.succeed(
              state.capabilities.filter(
                (capability) =>
                  capability.documentId === room.documentId &&
                  capability.generation === snapshot.metadata.sharing.generation,
              ),
            ),
          );
          if (!existing.some((capability) => capability.id === shareId)) {
            return yield* applicationFailure(
              "share_link_not_found",
              "The share link does not exist.",
              404,
            );
          }
          const remaining = existing.filter((capability) => capability.id !== shareId);
          const metadata = yield* room
            .updateSharing(principal, strongestCapabilityAccess(remaining), expectedRevision, now)
            .pipe(Effect.mapError(toApplicationError));
          const result = yield* withState(
            Effect.gen(function* () {
              const documentCapabilities = remaining.map((capability) =>
                capabilityWithGeneration(capability, metadata.sharing.generation),
              );
              const capabilities = [
                ...state.capabilities.filter((item) => item.documentId !== room.documentId),
                ...documentCapabilities,
              ];
              yield* saveState({ ...state, capabilities }).pipe(
                Effect.mapError(toApplicationError),
              );
              yield* persistPrivateDocumentState(state, room.documentId, objectStore, digest).pipe(
                Effect.mapError(toApplicationError),
              );
              return shareLinksResponse(metadata, documentCapabilities, baseUrl);
            }),
          );
          yield* projectDocument(room);
          yield* scheduleCheckpoint(room);
          return result;
        }),
      unlockShareLink: (credentials, rawDocumentId, password) =>
        withState(
          Effect.gen(function* () {
            const token = credentials.capabilityToken;
            if (token === undefined) {
              return yield* applicationFailure(
                "invalid_capability",
                "The capability is invalid.",
                401,
              );
            }
            const capability = yield* findCapabilityRecord(
              state,
              token,
              rawDocumentId,
              tokenHasher,
            );
            if (capability.passwordHash === undefined || capability.passwordProof === undefined) {
              return yield* applicationFailure(
                "share_password_not_required",
                "This share link does not require a password.",
                400,
              );
            }
            const valid = yield* hasher
              .verify(password, capability.passwordHash)
              .pipe(Effect.mapError(toApplicationError));
            if (!valid) {
              return yield* applicationFailure(
                "invalid_share_password",
                "The share password is incorrect.",
                401,
              );
            }
            return {
              capabilityId: capability.id,
              proof: capability.passwordProof,
              unlocked: true as const,
            };
          }),
        ),
    };

    return service;
  });
}

/** Search is a projection: when it is unavailable, listings degrade instead of failing. */
function searchFallback<B>(fallback: B) {
  return <A, E extends { readonly message: string }, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A | B, never, R> =>
    effect.pipe(
      Effect.catchAll((error) =>
        Effect.logWarning("Search index unavailable", error.message).pipe(
          Effect.as<A | B>(fallback),
        ),
      ),
    );
}

export function localApplicationLayer(options: LocalApplicationOptions = {}) {
  return Layer.effect(InklingApplication, makeLocalInklingApplication(options));
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

interface StoredPrivateDocumentState {
  readonly documentId: string;
  readonly decoded: typeof privateDocumentStateSchema.Type;
}

/** Reads the private state documents keep in object storage, concurrently. */
function loadPrivateDocumentStates(
  workspaceId: string,
  documentIds: readonly string[],
  objectStore: typeof ObjectStore.Service,
): Effect.Effect<readonly StoredPrivateDocumentState[], StorageError> {
  return Effect.forEach(
    documentIds,
    (id) =>
      objectStore.get(privateDocumentStateKey(workspaceId, id)).pipe(
        Effect.flatMap((stored) =>
          stored === undefined
            ? Effect.succeed([])
            : Schema.decodeUnknown(Schema.parseJson(privateDocumentStateSchema))(
                textDecoder.decode(stored.bytes),
              ).pipe(
                Effect.mapError(
                  (cause) =>
                    new StorageError({
                      cause,
                      message: `Private document state is corrupt for ${id}.`,
                      operation: "decode private document state",
                      retryable: false,
                    }),
                ),
                Effect.map((decoded) => [{ decoded, documentId: id }]),
              ),
        ),
      ),
    { concurrency: 16 },
  ).pipe(Effect.map((loaded) => loaded.flat()));
}

/** Merges stored private document state into the workspace state; newer sharing generations win. */
function mergePrivateDocumentStates(
  initial: LocalWorkspaceState,
  stored: readonly StoredPrivateDocumentState[],
): LocalWorkspaceState {
  const replacedCapabilities = new Map<string, readonly CapabilityRecord[]>();
  const attachments: Record<string, readonly AttachmentMetadataDto[]> = {
    ...initial.attachments,
  };
  for (const { decoded, documentId: id } of stored) {
    const projectedCapabilities = decoded.capabilities as readonly CapabilityRecord[];
    const localGeneration = Math.max(
      -1,
      ...initial.capabilities
        .filter((capability) => capability.documentId === id)
        .map((capability) => capability.generation),
    );
    const projectedGeneration = Math.max(
      -1,
      ...projectedCapabilities.map((capability) => capability.generation),
    );
    if (projectedGeneration >= localGeneration) replacedCapabilities.set(id, projectedCapabilities);
    const projectedAttachments = decoded.attachments as unknown as readonly AttachmentMetadataDto[];
    attachments[id] = [...(initial.attachments[id] ?? []), ...projectedAttachments].filter(
      (attachment, index, all) =>
        all.findIndex((candidate) => candidate.id === attachment.id) === index,
    );
  }
  return {
    ...initial,
    attachments,
    capabilities: [
      ...initial.capabilities.filter(
        (capability) => !replacedCapabilities.has(capability.documentId),
      ),
      ...[...replacedCapabilities.values()].flat(),
    ],
  };
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
          authentication: normalizeAuthenticationState(decoded.authentication),
          attachments: Object.fromEntries(
            Object.entries(decoded.attachments ?? {}).map(([documentKey, attachments]) => [
              documentKey,
              attachments as unknown as readonly AttachmentMetadataDto[],
            ]),
          ),
          catalog: normalizeWorkspaceCatalog(decoded.catalog as WorkspaceCatalogState),
        })),
      );
    }),
  );
}

function normalizeAuthenticationState(value: unknown): AuthenticationState {
  if (!Predicate.isReadonlyRecord(value)) return emptyAuthenticationState();
  const sessions = Array.isArray(value["sessions"])
    ? value["sessions"].filter(
        (session): session is SessionRecord =>
          Predicate.isReadonlyRecord(session) &&
          typeof session["personId"] === "string" &&
          (session["role"] === "member" || session["role"] === "administrator"),
      )
    : [];
  const apiKeys = Array.isArray(value["apiKeys"])
    ? value["apiKeys"].filter(
        (key): key is ApiKeyRecord =>
          Predicate.isReadonlyRecord(key) &&
          typeof key["personId"] === "string" &&
          (key["role"] === "member" || key["role"] === "administrator"),
      )
    : [];
  const authorizationCodes = Array.isArray(value["authorizationCodes"])
    ? value["authorizationCodes"].filter(
        (code): code is AuthorizationCodeRecord =>
          Predicate.isReadonlyRecord(code) &&
          typeof code["id"] === "string" &&
          typeof code["personId"] === "string" &&
          typeof code["expiresAt"] === "string" &&
          (code["role"] === "member" || code["role"] === "administrator"),
      )
    : [];
  return { apiKeys, authorizationCodes, sessions };
}

function resolveCapability(
  state: LocalWorkspaceState,
  token: string,
  targetDocumentId: string,
  guestName: string | undefined,
  capabilityProof: string | undefined,
  tokenHasher: typeof TokenHasher.Service,
): Effect.Effect<Extract<Principal, { readonly kind: "capability" }>, ApplicationError> {
  return Effect.gen(function* () {
    const record = yield* findCapabilityRecord(state, token, targetDocumentId, tokenHasher);
    if (
      record.passwordHash !== undefined &&
      (record.passwordProof === undefined || record.passwordProof !== capabilityProof)
    ) {
      return yield* applicationFailure(
        "capability_password_required",
        "This share link requires a password.",
        401,
      );
    }
    const guestId =
      guestName === undefined
        ? undefined
        : yield* personId(`${identifierTag.guest}_${record.id}`).pipe(
            Effect.mapError(toApplicationError),
          );
    return {
      access: record.access,
      documentId: targetDocumentId,
      expiresAt: record.expiresAt,
      generation: record.generation,
      guestId,
      kind: "capability",
    };
  });
}

function findCapabilityRecord(
  state: LocalWorkspaceState,
  token: string,
  targetDocumentId: string,
  tokenHasher: typeof TokenHasher.Service,
): Effect.Effect<CapabilityRecord, ApplicationError> {
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
      !(yield* tokenHasher
        .verify(secret, record.tokenHash)
        .pipe(Effect.mapError(toApplicationError)))
    ) {
      return yield* applicationFailure("invalid_capability", "The capability is invalid.", 401);
    }
    if (record.expiresAt !== undefined && Date.parse(record.expiresAt) <= Date.now()) {
      return yield* applicationFailure("invalid_capability", "The capability has expired.", 401);
    }
    return record;
  });
}

function capabilityWithGeneration(
  capability: CapabilityRecord,
  generation: number,
): CapabilityRecord {
  return { ...capability, generation };
}

function sameShareConfiguration(
  capability: CapabilityRecord,
  request: ShareLinkCreateRequest,
): boolean {
  return (
    capability.access === request.access &&
    capability.expiresAt === request.expiresAt &&
    (capability.passwordHash !== undefined) === (request.password !== undefined)
  );
}

function strongestCapabilityAccess(
  capabilities: readonly { readonly access: Exclude<CapabilityAccess, "disabled"> }[],
): CapabilityAccess {
  if (capabilities.some((capability) => capability.access === "edit")) return "edit";
  if (capabilities.some((capability) => capability.access === "comment")) return "comment";
  return capabilities.length === 0 ? "disabled" : "view";
}

function shareLinksResponse(
  metadata: DocumentMetadata,
  capabilities: readonly CapabilityRecord[],
  baseUrl: string,
): ShareLinksResponse {
  const links = capabilities
    .map((capability): ShareLinkDto => {
      const capabilityToken =
        capability.retainedSecret === undefined
          ? undefined
          : `cap.${capability.documentId}.${capability.id}.${capability.retainedSecret}`;
      return {
        access: capability.access,
        createdAt: capability.createdAt ?? metadata.createdAt,
        expiresAt: capability.expiresAt,
        id: capability.id,
        passwordProtected: capability.passwordHash !== undefined,
        url:
          capabilityToken === undefined
            ? undefined
            : `${baseUrl}/share/${encodeURIComponent(capability.documentId)}?cap=${encodeURIComponent(capabilityToken)}`,
      };
    })
    .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt));
  return { links, policy: metadata.sharing, revision: metadata.headRevision };
}

/** Whether a catalog summary may surface to the principal at all. */
function mayDiscover(principal: Principal, summary: CatalogSummary, now: string): boolean {
  // Summaries without metadata predate personal documents; callers that list
  // them check the authoritative metadata once they load it.
  return (
    summary.metadata === undefined ||
    isDocumentActionAllowed(principal, "discover", summary.metadata, now)
  );
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

function summaryFromSnapshot(snapshot: DocumentSnapshot): Effect.Effect<CatalogSummary> {
  return summaryFromDocument(toDocumentResponse(snapshot));
}

/** Headings a catalog summary keeps for resolving references. */
const maximumCatalogHeadings = 300;

function catalogHeadings(document: DocumentResponse): Effect.Effect<readonly CatalogHeading[]> {
  return outlineDocument(document.body, {
    numberHeadings: document.metadata.rfcNumber !== undefined,
  }).pipe(
    Effect.map((outline) =>
      outline.headings
        .slice(0, maximumCatalogHeadings)
        .map((heading): CatalogHeading =>
          heading.number === undefined
            ? { id: heading.id, text: heading.text.slice(0, 200) }
            : { id: heading.id, number: heading.number, text: heading.text.slice(0, 200) },
        ),
    ),
    Effect.orElseSucceed((): readonly CatalogHeading[] => []),
  );
}

function summaryFromDocument(document: DocumentResponse): Effect.Effect<CatalogSummary> {
  return parseDocumentSource(document.body).pipe(
    Effect.map((source) => source.frontmatter?.labels ?? document.metadata.labels),
    Effect.catchAll(() => Effect.succeed(document.metadata.labels)),
    Effect.zip(catalogHeadings(document)),
    Effect.map(([workingLabels, headings]) => ({
      approvers: document.metadata.approvers as readonly PersonReference[],
      authors: document.metadata.authors as readonly PersonReference[],
      documentId: document.metadata.id as DocumentMetadata["id"],
      excerpt: excerpt(document.body),
      headings,
      labels: document.metadata.labels,
      metadata: document.metadata as DocumentMetadata,
      publishedRevision: document.metadata.publishedRevision as DocumentRevision | undefined,
      revision: document.metadata.headRevision as DocumentRevision,
      reviewers: document.metadata.reviewers as readonly PersonReference[],
      rfcNumber: document.metadata.rfcNumber,
      state: document.metadata.lifecycleState,
      title: document.metadata.title,
      updatedAt: document.metadata.updatedAt,
      visibility: document.metadata.visibility,
      workingLabels,
    })),
  );
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
  resolveReferences: (
    references: readonly DocumentReference[],
  ) => Effect.Effect<ReferenceResolutions>,
): Effect.Effect<void, StorageError> {
  return Effect.gen(function* () {
    const revision = snapshot.metadata.publishedRevision;
    if (revision === undefined) return;
    const references = yield* collectReferences(snapshot.body).pipe(
      Effect.orElseSucceed((): readonly DocumentReference[] => []),
    );
    const rendered = yield* renderer
      .render(snapshot.body, {
        numberHeadings: snapshot.metadata.rfcNumber !== undefined,
        protectedLinkHref: ({ index }) => protectedLinkPath(snapshot.metadata.id, revision, index),
        references: yield* resolveReferences(references),
        unavailableReferenceHref: ({ index }) =>
          referenceLinkPath(snapshot.metadata.id, revision, index),
      })
      .pipe(
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
    const description = escapeMarkup(
      excerpt(
        rewriteProtectedLinkSources(
          redactPublicText(snapshot.body),
          rendered.protectedLinks,
          () => "protected-link",
        ),
      ),
    );
    const canonical =
      snapshot.metadata.rfcNumber === undefined
        ? `/documents/${snapshot.metadata.id}`
        : canonicalRfcPath(snapshot.metadata.rfcNumber);
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

function withMetadataFrontmatter(body: string, metadata: DocumentMetadata): string {
  const frontmatter = serializeDocumentFrontmatter({
    authors: metadata.authors.map((author) => author.email.toLocaleLowerCase("en")),
    labels: metadata.labels,
    state: metadata.lifecycleState,
    visibility: metadata.visibility,
  });
  let source = body.startsWith("---\n") ? body : `${frontmatter}\n${body}`;
  if (body.startsWith("---\n") && !/^authors[\t ]*:/mu.test(body)) {
    source = body.replace(/^---\n/u, `---\n${authorsFrontmatterEntry(metadata.authors)}`);
  }
  if (documentTitleFromMarkdown(source) !== undefined) return source;

  const title = metadata.title.replace(/\s+/gu, " ").trim();
  const heading = `# ${title}\n`;
  const match = /^---\n[\s\S]*?\n---[\t ]*(?:\n|$)/u.exec(source);
  if (match === null) return body.startsWith("---\n") ? source : `${heading}\n${source}`;
  const remaining = source.slice(match[0].length).trimStart();
  return `${match[0]}\n${heading}${remaining === "" ? "" : `\n${remaining}`}`;
}

function authorsFrontmatterEntry(authors: readonly PersonReference[]): string {
  return authors.length === 0
    ? "authors: []\n"
    : `authors:\n${authors.map((author) => `  - ${JSON.stringify(author.email.toLocaleLowerCase("en"))}\n`).join("")}`;
}

/**
 * Text of a published body for public listings and search: protected link
 * destinations and the section IDs of references are removed, since either
 * may name something the public cannot open.
 */
function redactPublicText(body: string): string {
  const withoutReferenceSections = body.replace(
    /\b((?:rfc|doc):[A-Za-z0-9_-]+)#[\p{Letter}\p{Number}\p{Mark}_%-]*/gu,
    "$1",
  );
  return withoutReferenceSections.includes("__require_auth")
    ? withoutReferenceSections.replace(/https?:\/\/[^\s<>"']+/giu, "protected-link")
    : withoutReferenceSections;
}

/** Hides the section IDs of references an anonymous reader cannot open. */
function redactUnavailableReferences(
  body: string,
  references: readonly DocumentReference[],
  resolutions: ReferenceResolutions,
  redirectPath: (index: number) => string,
): string {
  const firstIndex = new Map<string, number>();
  for (const reference of references) {
    if (!firstIndex.has(reference.key)) firstIndex.set(reference.key, reference.index);
  }
  return redactReferences(body, {
    available: (reference) => resolutions.get(reference.key)?.status === "available",
    redirect: (reference) => {
      const index = firstIndex.get(reference.key);
      return index === undefined ? undefined : redirectPath(index);
    },
  });
}

/** The reader path a reference leads to. */
function referenceDestination(reference: ParsedReference): string {
  return `${referenceTargetPath(reference.target)}${
    reference.anchor === undefined ? "" : `#${encodeURIComponent(reference.anchor)}`
  }`;
}

function rewriteProtectedLinkSources(
  body: string,
  links: readonly { readonly index: number; readonly source: string }[],
  replacement: (link: { readonly index: number; readonly source: string }) => string,
): string {
  let rewritten = body;
  const handled = new Set<string>();
  for (const link of links) {
    if (handled.has(link.source)) continue;
    handled.add(link.source);
    if (!rewritten.includes(link.source)) return "";
    rewritten = rewritten.replaceAll(link.source, replacement(link));
  }
  return rewritten;
}

function excerpt(body: string): string {
  const withoutFrontmatter = body.replace(/^---\n[\s\S]*?\n---[\t ]*(?:\n|$)/u, "");
  return withoutFrontmatter
    .replace(/```[\s\S]*?```/gu, " ")
    .replace(/^ {0,3}#[\t ]+.+(?:\n|$)/mu, " ")
    .replace(/^(.+)\n {0,3}=+[\t ]*(?:\n|$)/mu, " ")
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

function apiKeyDto(record: ApiKeyRecord, fallbackPersonId: PersonReference["id"]): ApiKeyDto {
  return {
    createdAt: record.createdAt,
    id: record.id,
    label: record.label,
    lastUsedAt: record.lastUsedAt,
    oauthClientName: record.oauthClientName,
    personId: record.personId ?? fallbackPersonId,
    revealable: record.retainedSecret !== undefined,
    revokedAt: record.revokedAt,
  };
}

function requireAccount(principal: Principal): Effect.Effect<
  {
    readonly displayName?: string | undefined;
    readonly personId: PersonReference["id"];
    readonly role: "member" | "administrator";
  },
  ApplicationError
> {
  if (principal.kind !== "workspace" && principal.kind !== "api-key") {
    return applicationFailure("forbidden", "Workspace account access is required.", 403);
  }
  return Effect.succeed({
    displayName: principal.displayName,
    personId: principal.personId,
    role: principal.role,
  });
}

function requireAdministrator(principal: Principal): Effect.Effect<void, ApplicationError> {
  return (principal.kind === "workspace" || principal.kind === "api-key") &&
    principal.role === "administrator"
    ? Effect.void
    : applicationFailure("forbidden", "Workspace administrator access is required.", 403);
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
      targetDecisionDate: request.targetDecisionDate,
      visibility: request.visibility,
    };
  });
}

function workspacePeople(
  catalog: WorkspaceCatalogState,
  authentication: AuthenticationState,
): readonly PersonReference[] {
  const people = new Map(
    catalog.people.map((entry) => [entry.person.email.toLocaleLowerCase("en"), entry.person]),
  );
  for (const session of authentication.sessions) {
    const email = session.email?.trim().toLocaleLowerCase("en");
    const displayName = session.displayName?.trim();
    if (
      email === undefined ||
      email === "" ||
      displayName === undefined ||
      displayName === "" ||
      session.personId === undefined
    ) {
      continue;
    }
    people.set(email, { displayName, email, id: session.personId });
  }
  return [...people.values()];
}

function knownPeopleByEmail(
  catalog: WorkspaceCatalogState,
  authentication: AuthenticationState,
  emails: readonly string[],
): readonly PersonReference[] {
  const people = workspacePeople(catalog, authentication);
  return emails.flatMap((value): readonly PersonReference[] => {
    const email = value.trim().toLocaleLowerCase("en");
    const direct = people.find((person) => person.email.trim().toLocaleLowerCase("en") === email);
    if (direct !== undefined) return [direct];
    const normalized = normalizeSearchText(email);
    const aliased = catalog.people.find((entry) => entry.aliases.includes(normalized))?.person;
    return aliased === undefined ? [] : [{ ...aliased, email }];
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
      status: error.code === "invalid_grant" ? 400 : 401,
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
  if (error instanceof RenderError) {
    return new ApplicationError({
      cause: error,
      code: "invalid_document_source",
      message: error.message,
      retryable: false,
      status: 400,
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
