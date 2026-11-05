import { DurableObject } from "cloudflare:workers";
import { Effect, Layer, ManagedRuntime } from "effect";
import type { ManagedRuntime as ManagedRuntimeType } from "effect";

import {
  documentTrashRetentionMilliseconds,
  DurableDocumentJournal,
  ObjectStore,
  SearchIndex,
  WorkspaceStateStore,
} from "@earendil-works/inkling-core";
import type {
  PeopleDirectoryEntry,
  PersonReference,
  Principal,
  WorkspaceIdentity,
} from "@earendil-works/inkling-core";
import {
  agentResourceUnavailableResponse,
  ApplicationError,
  staticAssetCacheControl,
  createBackendApp,
  decodeThemeJson,
  DigestLive,
  DisabledSearchIndexLive,
  findBundledTheme,
  isDefaultThemeSelection,
  finishGoogleAuthentication,
  handleMcpRequest,
  IdGeneratorLive,
  isOAuthPath,
  InklingApplication,
  localApplicationLayer,
  makeSqlSearchIndex,
  mcpEndpointPath,
  rfcRedirectLocation,
  SecureTokenLive,
  TokenHasherLive,
  shareProofCookieNameFromToken,
  startGoogleAuthentication,
  themeCssResponse,
} from "@earendil-works/inkling-backend";
import type {
  DocumentRuntimeConfiguration,
  InklingApplicationService,
  LocalApplicationOptions,
  RequestCredentials,
  SessionResult,
  ThemeConfiguration,
  ThemeError,
} from "@earendil-works/inkling-backend";
import { decodeBase64 } from "@earendil-works/inkling-collaboration";
import {
  ClientCollaborationMessageSchema,
  decodeJson,
  encodeJson,
  ServerCollaborationMessageSchema,
} from "@earendil-works/inkling-protocol";
import type {
  ClientCollaborationMessage,
  DocumentMetadataDto,
  DocumentResponse,
  PresenceDto,
  ReferenceResolutionsResponse,
  ServerCollaborationMessage,
} from "@earendil-works/inkling-protocol";
import { renderApplication } from "@earendil-works/inkling-frontend/server";
import { MarkdownRendererLive } from "@earendil-works/inkling-renderer";

import { CloudflareSecretHasherLive } from "./crypto.ts";
import {
  defaultEmbeddingModel,
  makeDurableObjectSearchDatabase,
  makeVectorizeStore,
  makeWorkersAiEmbedder,
} from "./search.ts";
import {
  makeDurableObjectJournal,
  makeDurableWorkspaceStateStore,
  makeR2ObjectStore,
  WebCryptoDigest,
} from "./storage.ts";

export interface CloudflareEnvironment {
  /** Workers AI; with INKLING_VECTORS it enables semantic search. */
  readonly AI?: Ai | undefined;
  readonly ASSETS: Fetcher;
  readonly GOOGLE_ADMIN_EMAILS?: string | undefined;
  readonly GOOGLE_ALLOWED_DOMAIN?: string | undefined;
  readonly GOOGLE_ALLOWED_DOMAINS?: string | undefined;
  readonly GOOGLE_CLIENT_ID?: string | undefined;
  readonly GOOGLE_CLIENT_SECRET?: string | undefined;
  readonly GOOGLE_REDIRECT_URI?: string | undefined;
  readonly INKLING_GOOGLE_AUTHORIZATION_ENDPOINT?: string | undefined;
  readonly INKLING_GOOGLE_CERTIFICATES_ENDPOINT?: string | undefined;
  readonly INKLING_GOOGLE_DIRECTORY_ENDPOINT?: string | undefined;
  readonly INKLING_GOOGLE_TOKEN_ENDPOINT?: string | undefined;
  readonly INKLING_OAUTH_STATE_SECRET?: string | undefined;
  readonly INKLING_THEME?: string | undefined;
  readonly INKLING_DOCUMENTS: DurableObjectNamespace<DocumentDurableObject>;
  /** Workers AI text embedding model; the Vectorize index must match its dimensions. */
  readonly INKLING_EMBEDDING_MODEL?: string | undefined;
  readonly INKLING_OBJECTS: R2Bucket;
  /** Vectorize index for semantic search, created with the cosine metric. */
  readonly INKLING_VECTORS?: Vectorize | undefined;
  readonly INKLING_WORKSPACE: DurableObjectNamespace<WorkspaceDurableObject>;
}

interface SocketAttachment {
  readonly credentials: RequestCredentials;
  readonly documentId: string;
  readonly initialized: boolean;
  readonly presence?: PresenceDto | undefined;
  readonly principal?: Principal | undefined;
  readonly updateTimes: readonly number[];
}

interface RpcError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly status: number;
}

type RpcResult<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly error: RpcError; readonly ok: false };

/** Low-traffic authority for authentication, allocation, and catalog projections. */
export class WorkspaceDurableObject extends DurableObject<CloudflareEnvironment> {
  readonly #state: DurableObjectState;
  readonly #runtime: ManagedRuntimeType.ManagedRuntime<InklingApplicationService, never>;
  readonly #app: ReturnType<typeof createBackendApp>;

  constructor(state: DurableObjectState, environment: CloudflareEnvironment) {
    super(state, environment);
    this.#state = state;
    this.#runtime = createApplicationRuntime(
      state,
      environment,
      {
        ownsDocumentPrivateState: false,
        workspaceId: state.id.toString(),
      },
      "workspace",
    );
    this.#app = createBackendApp({ runtime: this.#runtime, version: "cloudflare" });
    const started = Date.now();
    state.blockConcurrencyWhile(() =>
      this.#runtime.runtime().then(() => logStartup("workspace", Date.now() - started)),
    );
  }

  override async fetch(request: Request): Promise<Response> {
    const response = await this.#app.fetch(request);
    if (isMutation(request) && response.ok) await this.#scheduleAlarm(2_000);
    return response;
  }

  override async alarm(): Promise<void> {
    await this.#runtime.runPromise(
      Effect.flatMap(InklingApplication, (application) => application.checkpointAll()),
    );
    if (!semanticSearchConfigured(this.env)) return;
    const pending = await this.#runtime.runPromise(
      Effect.flatMap(InklingApplication, (application) => application.refreshSearchIndex()).pipe(
        Effect.tapError((error) => Effect.logError("Search embedding failed", error.message)),
        Effect.orElseSucceed(() => -1),
      ),
    );
    if (pending !== 0) await this.#scheduleSearchRefresh(pending > 0 ? 5_000 : 60_000);
  }

  /** Embedding runs from the alarm so passages are embedded once edits settle. */
  async #scheduleSearchRefresh(delay: number): Promise<void> {
    if (!semanticSearchConfigured(this.env)) return;
    await this.#scheduleAlarm(delay);
  }

  /**
   * Runs the alarm within `delay` without postponing an earlier one. The
   * alarm checkpoints and writes the catalog projections that changes left
   * pending.
   */
  async #scheduleAlarm(delay: number): Promise<void> {
    const at = Date.now() + delay;
    const current = await this.#state.storage.getAlarm();
    if (current === null || current > at) await this.#state.storage.setAlarm(at);
  }

  /** Catalog changes from document authorities are written to object storage by the alarm. */
  async #afterCatalogChange<A>(result: RpcResult<A>): Promise<RpcResult<A>> {
    if (result.ok) await this.#scheduleAlarm(2_000);
    return result;
  }

  async loginIdentity(
    identity: WorkspaceIdentity,
    people: readonly PeopleDirectoryEntry[] = [],
  ): Promise<RpcResult<SessionResult>> {
    return this.#afterCatalogChange(
      await runRpc(
        this.#runtime,
        Effect.flatMap(InklingApplication, (application) =>
          application.loginWorkspaceIdentity(identity, people),
        ),
      ),
    );
  }

  async authorize(
    requestCredentials: RequestCredentials,
    documentId?: string,
  ): Promise<RpcResult<Principal>> {
    return runRpc(
      this.#runtime,
      Effect.flatMap(InklingApplication, (application) =>
        application.authorizeRequest(requestCredentials, documentId),
      ),
    );
  }

  async resolvePeople(emails: readonly string[]): Promise<RpcResult<readonly PersonReference[]>> {
    return runRpc(
      this.#runtime,
      Effect.flatMap(InklingApplication, (application) => application.resolvePeople(emails)),
    );
  }

  async configurations(): Promise<RpcResult<readonly DocumentRuntimeConfiguration[]>> {
    return runRpc(
      this.#runtime,
      Effect.flatMap(InklingApplication, (application) =>
        Effect.gen(function* () {
          yield* application.checkpointAll();
          const configurations = yield* application.allDocumentRuntimeConfigurations();
          yield* Effect.forEach(configurations, (configuration) =>
            application.releaseDocumentRoom(configuration.documentId),
          );
          return configurations;
        }),
      ),
    );
  }

  async configuration(documentId: string): Promise<RpcResult<DocumentRuntimeConfiguration>> {
    return runRpc(
      this.#runtime,
      Effect.flatMap(InklingApplication, (application) =>
        Effect.gen(function* () {
          yield* application.checkpointAll();
          const configuration = yield* application.documentRuntimeConfiguration(documentId);
          yield* application.releaseDocumentRoom(documentId);
          return configuration;
        }),
      ),
    );
  }

  async reserveRfcNumber(
    requestCredentials: RequestCredentials,
    documentId: string,
  ): Promise<RpcResult<number>> {
    return this.#afterCatalogChange(
      await runRpc(
        this.#runtime,
        Effect.flatMap(InklingApplication, (application) =>
          application.reserveRfcNumber(requestCredentials, documentId),
        ),
      ),
    );
  }

  async applyProjection(document: DocumentResponse): Promise<RpcResult<boolean>> {
    const result = await runRpc(
      this.#runtime,
      Effect.flatMap(InklingApplication, (application) =>
        application.applyDocumentProjection(document).pipe(Effect.as(true)),
      ),
    );
    if (result.ok) await this.#scheduleSearchRefresh(12_000);
    return this.#afterCatalogChange(result);
  }

  async markDeleted(document: DocumentResponse): Promise<RpcResult<boolean>> {
    return this.#afterCatalogChange(
      await runRpc(
        this.#runtime,
        Effect.flatMap(InklingApplication, (application) =>
          application.markCatalogDeleted(document).pipe(Effect.as(true)),
        ),
      ),
    );
  }

  async markRestored(document: DocumentResponse): Promise<RpcResult<boolean>> {
    return this.#afterCatalogChange(
      await runRpc(
        this.#runtime,
        Effect.flatMap(InklingApplication, (application) =>
          application.markCatalogRestored(document).pipe(Effect.as(true)),
        ),
      ),
    );
  }

  async markPurged(documentId: string): Promise<RpcResult<boolean>> {
    return this.#afterCatalogChange(
      await runRpc(
        this.#runtime,
        Effect.flatMap(InklingApplication, (application) =>
          application.markCatalogPurged(documentId).pipe(Effect.as(true)),
        ),
      ),
    );
  }

  async resolveReferences(
    requestCredentials: RequestCredentials,
    references: readonly string[],
  ): Promise<RpcResult<ReferenceResolutionsResponse>> {
    return runRpc(
      this.#runtime,
      Effect.flatMap(InklingApplication, (application) =>
        application.resolveReferences(requestCredentials, references),
      ),
    );
  }

  async resolvePublicRfc(rfcNumber: number): Promise<RpcResult<DocumentRuntimeConfiguration>> {
    return runRpc(
      this.#runtime,
      Effect.flatMap(InklingApplication, (application) =>
        application.publicRfcRuntimeConfiguration(rfcNumber),
      ),
    );
  }
}

/** One hibernating collaboration and command authority per document. */
export class DocumentDurableObject extends DurableObject<CloudflareEnvironment> {
  readonly #state: DurableObjectState;
  readonly #environment: CloudflareEnvironment;
  #runtime: ManagedRuntimeType.ManagedRuntime<InklingApplicationService, never> | undefined;
  #app: ReturnType<typeof createBackendApp> | undefined;
  #configuration: DocumentRuntimeConfiguration | undefined;
  /** Mirrors the stored `catalog:stale` flag so keystrokes write it only once. */
  #catalogStale = false;
  #catalogProjectionTimer: ReturnType<typeof setTimeout> | undefined;
  readonly #principals = new Map<
    string,
    { readonly expiresAt: number; readonly principal: Principal }
  >();

  constructor(state: DurableObjectState, environment: CloudflareEnvironment) {
    super(state, environment);
    this.#state = state;
    this.#environment = environment;
  }

  async initialize(configuration: DocumentRuntimeConfiguration): Promise<RpcResult<boolean>> {
    const existing = await this.#state.storage.get<DocumentRuntimeConfiguration>("document:config");
    if (existing !== undefined && existing.documentId !== configuration.documentId) {
      return {
        error: {
          code: "document_binding_mismatch",
          message: "The Durable Object is already bound to another document.",
          retryable: false,
          status: 409,
        },
        ok: false,
      };
    }
    if (existing === undefined) {
      await this.#state.storage.put("document:config", configuration);
      await this.#state.storage.put("workspace:state", isolatedWorkspaceState(configuration));
    }
    await this.#ensureRuntime(existing ?? configuration);
    return { ok: true, value: true };
  }

  async flush(): Promise<RpcResult<boolean>> {
    try {
      await this.alarm();
      return { ok: true, value: true };
    } catch {
      return {
        error: {
          code: "checkpoint_failed",
          message: "The document could not be checkpointed for backup.",
          retryable: true,
          status: 503,
        },
        ok: false,
      };
    }
  }

  async assignRfcNumber(
    requestCredentials: RequestCredentials,
    documentId: string,
    rfcNumber: number,
  ): Promise<RpcResult<DocumentMetadataDto>> {
    const configuration = await this.#loadConfiguration();
    if (configuration === undefined || configuration.documentId !== documentId) {
      return {
        error: {
          code: "document_not_initialized",
          message: "The document authority has not been initialized.",
          retryable: true,
          status: 503,
        },
        ok: false,
      };
    }
    await this.#ensureRuntime(configuration);
    const runtime = this.#runtime;
    if (runtime === undefined) {
      return {
        error: {
          code: "document_runtime_unavailable",
          message: "The document authority is unavailable.",
          retryable: true,
          status: 503,
        },
        ok: false,
      };
    }
    const result = await runRpc(
      runtime,
      Effect.flatMap(InklingApplication, (application) =>
        application.assignRfcNumber(requestCredentials, documentId, rfcNumber),
      ),
    );
    if (result.ok) {
      const projection = await runtime.runPromise(
        Effect.flatMap(InklingApplication, (application) =>
          application.currentDocumentProjection(documentId),
        ),
      );
      await this.#queueProjection(projection);
      await this.#requestResynchronization();
    }
    return result;
  }

  override async fetch(request: Request): Promise<Response> {
    const configuration = await this.#loadConfiguration();
    if (configuration === undefined) {
      const response = protocolErrorResponse({
        code: "document_not_initialized",
        message: "The document authority has not been initialized.",
        retryable: true,
        status: 503,
      });
      response.headers.set(uninitializedDocumentHeader, "1");
      return response;
    }
    await this.#ensureRuntime(configuration);
    const runtime = this.#runtime;
    const app = this.#app;
    if (runtime === undefined || app === undefined) {
      return protocolErrorResponse({
        code: "document_runtime_unavailable",
        message: "The document authority is unavailable.",
        retryable: true,
        status: 503,
      });
    }

    const url = new URL(request.url);
    const match = /^\/api\/documents\/([^/]+)\/ws$/u.exec(url.pathname);
    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket" && match?.[1] !== undefined) {
      return this.#upgrade(request, configuration.documentId);
    }

    const response = await app.fetch(request);
    if (isMutation(request) && response.ok) {
      const base = `/api/documents/${encodeURIComponent(configuration.documentId)}`;
      if (request.method === "DELETE" && url.pathname === `${base}/permanent`) {
        await this.#queuePurge(configuration.documentId);
        await this.#requestResynchronization();
      } else {
        const projection = await runtime.runPromise(
          Effect.flatMap(InklingApplication, (application) =>
            application.currentDocumentProjection(configuration.documentId),
          ),
        );
        if (request.method === "DELETE" && url.pathname === base) {
          await this.#queueDeletion(projection);
        } else if (request.method === "POST" && url.pathname === `${base}/restore`) {
          await this.#queueRestoration(projection);
        } else {
          this.#state.waitUntil(this.#queueProjection(projection));
        }
        if (isBodyMutation(request.method, url.pathname, configuration.documentId)) {
          await this.#broadcastBodyMutation(request, configuration.documentId, projection);
        } else if (isPublicationMutation(url.pathname, configuration.documentId)) {
          await Effect.runPromise(
            this.#broadcast({ metadata: projection.metadata, type: "metadata-changed" }).pipe(
              Effect.catchAll(() => Effect.void),
            ),
          );
        } else {
          await this.#requestResynchronization();
        }
      }
    }
    return response;
  }

  override async alarm(): Promise<void> {
    const configuration = await this.#loadConfiguration();
    if (configuration === undefined) return;
    await this.#ensureRuntime(configuration);
    const runtime = this.#runtime;
    if (runtime === undefined) return;
    const purged = await runtime.runPromise(
      Effect.flatMap(InklingApplication, (application) =>
        application.purgeExpiredDocuments(new Date().toISOString()),
      ),
    );
    if (purged.includes(configuration.documentId)) {
      await this.#queuePurge(configuration.documentId);
      return;
    }
    await runtime.runPromise(
      Effect.flatMap(InklingApplication, (application) => application.checkpointAll()),
    );
    await this.#projectStaleCatalog();
    const finalized = await this.#flushCatalogOutbox();
    if (finalized) return;
    const projection = await runtime.runPromise(
      Effect.flatMap(InklingApplication, (application) =>
        application.currentDocumentProjection(configuration.documentId),
      ),
    );
    await this.#scheduleTrashPurge(projection.metadata.deletedAt);
  }

  override async webSocketMessage(
    socket: WebSocket,
    rawMessage: string | ArrayBuffer,
  ): Promise<void> {
    const attachment = socket.deserializeAttachment() as SocketAttachment | null;
    const configuration = await this.#loadConfiguration();
    if (attachment === null || configuration === undefined) {
      socket.close(4000, "missing_document_runtime");
      return;
    }
    await this.#ensureRuntime(configuration);
    const runtime = this.#runtime;
    if (runtime === undefined) {
      socket.close(4000, "missing_document_runtime");
      return;
    }
    const processed = decodeSocketMessage(rawMessage).pipe(
      Effect.flatMap((message) => this.#processSocketMessage(socket, attachment, message)),
      Effect.catchAll((error) => this.#sendSocketError(socket, error)),
    );
    await runtime.runPromise(processed);
  }

  override async webSocketClose(socket: WebSocket): Promise<void> {
    await this.#removePresence(socket);
  }

  override async webSocketError(socket: WebSocket): Promise<void> {
    await this.#removePresence(socket);
  }

  async #loadConfiguration(): Promise<DocumentRuntimeConfiguration | undefined> {
    if (this.#configuration !== undefined) return this.#configuration;
    const configuration =
      await this.#state.storage.get<DocumentRuntimeConfiguration>("document:config");
    this.#configuration = configuration;
    return configuration;
  }

  async #ensureRuntime(configuration: DocumentRuntimeConfiguration): Promise<void> {
    if (this.#runtime !== undefined) return;
    const resolver: NonNullable<LocalApplicationOptions["principalResolver"]> = (
      requestCredentials,
      documentId,
    ) => {
      const key = principalCacheKey(requestCredentials, documentId);
      const cached = key === undefined ? undefined : this.#principals.get(key);
      if (cached !== undefined && cached.expiresAt > Date.now()) {
        return Effect.succeed(cached.principal);
      }
      return callRpc(
        workspaceStub(this.#environment).authorize(requestCredentials, documentId),
      ).pipe(
        Effect.tap((principal) =>
          Effect.sync(() => {
            if (key !== undefined) this.#rememberPrincipal(key, principal);
          }),
        ),
      );
    };
    const peopleResolver: NonNullable<LocalApplicationOptions["peopleResolver"]> = (emails) =>
      callRpc(workspaceStub(this.#environment).resolvePeople(emails));
    // References name other documents, which only the workspace catalog knows.
    const referenceResolver: NonNullable<LocalApplicationOptions["referenceResolver"]> = (
      requestCredentials,
      references,
    ) =>
      callRpc(workspaceStub(this.#environment).resolveReferences(requestCredentials, references));
    const started = Date.now();
    const runtime = createApplicationRuntime(
      this.#state,
      this.#environment,
      {
        ownsCatalogProjections: false,
        peopleResolver,
        principalResolver: resolver,
        referenceResolver,
        workspaceId: configuration.workspaceId,
      },
      "disabled",
    );
    await runtime.runtime();
    logStartup("document", Date.now() - started);
    this.#configuration = configuration;
    this.#runtime = runtime;
    this.#app = createBackendApp({ runtime, version: "cloudflare-document" });
  }

  /**
   * Keeps principals the workspace resolved for signed-in credentials for a
   * short while, so reads do not each wait for the workspace. Revoking a
   * session or key therefore takes up to `principalCacheMilliseconds` to
   * reach a document that is already open.
   */
  #rememberPrincipal(key: string, principal: Principal): void {
    const now = Date.now();
    for (const [cachedKey, cached] of this.#principals) {
      if (cached.expiresAt <= now || this.#principals.size >= maximumCachedPrincipals) {
        this.#principals.delete(cachedKey);
      }
    }
    this.#principals.set(key, { expiresAt: now + principalCacheMilliseconds, principal });
  }

  /**
   * Collaboration updates refresh the catalog projection at most once per
   * interval. The stored flag lets the alarm finish the refresh when the
   * authority is evicted before its timer fires.
   */
  async #markCatalogStale(): Promise<void> {
    if (!this.#catalogStale) {
      await this.#state.storage.put("catalog:stale", true);
      this.#catalogStale = true;
    }
    if (this.#catalogProjectionTimer !== undefined) return;
    this.#catalogProjectionTimer = setTimeout(() => {
      this.#catalogProjectionTimer = undefined;
      this.#projectStaleCatalog().catch(() => undefined);
    }, catalogProjectionIntervalMilliseconds);
  }

  async #projectStaleCatalog(): Promise<void> {
    const runtime = this.#runtime;
    const configuration = this.#configuration;
    if (runtime === undefined || configuration === undefined) return;
    if ((await this.#state.storage.get<boolean>("catalog:stale")) !== true) return;
    // Cleared before projecting, so updates that arrive meanwhile mark it again.
    this.#catalogStale = false;
    await this.#state.storage.delete("catalog:stale");
    try {
      const projection = await runtime.runPromise(
        Effect.flatMap(InklingApplication, (application) =>
          application.currentDocumentProjection(configuration.documentId),
        ),
      );
      await this.#queueProjection(projection);
    } catch (error) {
      await this.#markCatalogStale();
      throw error;
    }
  }

  #upgrade(request: Request, documentId: string): Response {
    if (!isSameOrigin(request.headers.get("Origin"), request.url)) {
      return new Response("WebSocket origin rejected.", { status: 403 });
    }
    if (this.#state.getWebSockets().length >= 64) {
      return protocolErrorResponse({
        code: "participant_limit",
        message: "This document already has the maximum number of participants.",
        retryable: true,
        status: 429,
      });
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const attachment: SocketAttachment = {
      credentials: credentials(request),
      documentId,
      initialized: false,
      updateTimes: [],
    };
    server.serializeAttachment(attachment);
    this.#state.acceptWebSocket(server, [documentId]);
    return new Response(null, { status: 101, webSocket: client });
  }

  #processSocketMessage(
    socket: WebSocket,
    attachment: SocketAttachment,
    message: ClientCollaborationMessage,
  ): Effect.Effect<void, unknown, InklingApplicationService> {
    return Effect.gen(this, function* () {
      const application = yield* InklingApplication;
      if (!attachment.initialized) {
        if (message.type !== "hello") {
          return yield* protocolFailure(
            "protocol_required",
            "The first collaboration message must negotiate the protocol.",
          );
        }
        const stateVector =
          message.stateVector === undefined ? undefined : yield* decodeBase64(message.stateVector);
        const connection = yield* application.connectCollaboration(
          attachment.credentials,
          attachment.documentId,
          stateVector,
        );
        yield* send(socket, connection.welcome);
        const existingPresences = this.#state
          .getWebSockets(attachment.documentId)
          .flatMap((other) => {
            if (other === socket) return [];
            const otherAttachment = other.deserializeAttachment() as SocketAttachment | null;
            return otherAttachment?.presence === undefined ? [] : [otherAttachment.presence];
          });
        yield* Effect.forEach(
          existingPresences,
          (presence) => send(socket, { presence, type: "presence" }),
          { discard: true },
        );
        socket.serializeAttachment({
          ...attachment,
          initialized: true,
          principal: connection.principal,
        });
        return;
      }

      if (message.type === "body-update") {
        if (attachment.principal === undefined) {
          return yield* protocolFailure(
            "connection_missing",
            "The collaboration connection must be initialized again.",
          );
        }
        const updateTimes = (attachment.updateTimes ?? []).filter(
          (acceptedAt) => acceptedAt >= Date.now() - 10_000,
        );
        if (updateTimes.length >= 200) {
          return yield* Effect.fail(
            new ApplicationError({
              code: "update_rate_limit",
              message: "The collaboration update rate limit was exceeded.",
              retryable: true,
              status: 429,
            }),
          );
        }
        socket.serializeAttachment({ ...attachment, updateTimes: [...updateTimes, Date.now()] });
        const connection = yield* application.connectCollaboration(
          { internalPrincipal: attachment.principal },
          attachment.documentId,
        );
        const update = yield* decodeBase64(message.update);
        const accepted = yield* connection.acceptUpdate(update, message.clientUpdateId);
        yield* this.#broadcast(accepted);
        yield* Effect.tryPromise({
          catch: (cause) => cause,
          try: async () => {
            await this.#state.storage.setAlarm(Date.now() + 2_000);
            await this.#markCatalogStale();
          },
        });
        return;
      }

      if (message.type === "presence") {
        socket.serializeAttachment({ ...attachment, presence: message.presence });
        yield* this.#broadcast({ presence: message.presence, type: "presence" }, socket);
      }
    });
  }

  async #removePresence(socket: WebSocket): Promise<void> {
    const attachment = socket.deserializeAttachment() as SocketAttachment | null;
    if (attachment?.presence === undefined) return;
    const { presence, ...remaining } = attachment;
    socket.serializeAttachment(remaining);
    await Effect.runPromise(
      this.#broadcast(
        { participantId: presence.participantId, type: "presence-left" },
        socket,
      ).pipe(Effect.ignore),
    );
  }

  async #queueProjection(projection: DocumentResponse): Promise<void> {
    await this.#state.storage.transaction(async (transaction) => {
      const deletion = await transaction.get<DocumentResponse>("catalog:deletion");
      const restoration = await transaction.get<DocumentResponse>("catalog:restoration");
      const purge = await transaction.get<string>("catalog:purge");
      const pending = await transaction.get<DocumentResponse>("catalog:projection");
      if (
        deletion === undefined &&
        restoration === undefined &&
        purge === undefined &&
        (pending === undefined || pending.metadata.headRevision <= projection.metadata.headRevision)
      ) {
        await transaction.put("catalog:projection", projection);
      }
    });
    await this.#state.storage.setAlarm(Date.now() + 2_000);
    await this.#flushCatalogOutbox();
  }

  async #queueDeletion(document: DocumentResponse): Promise<void> {
    await this.#state.storage.transaction(async (transaction) => {
      await transaction.delete(["catalog:projection", "catalog:restoration"]);
      await transaction.put("catalog:deletion", document);
    });
    await this.#state.storage.setAlarm(Date.now() + 2_000);
    await this.#flushCatalogOutbox();
  }

  async #queueRestoration(document: DocumentResponse): Promise<void> {
    await this.#state.storage.transaction(async (transaction) => {
      await transaction.delete(["catalog:deletion", "catalog:projection"]);
      await transaction.put("catalog:restoration", document);
    });
    await this.#state.storage.setAlarm(Date.now() + 2_000);
    await this.#flushCatalogOutbox();
  }

  async #queuePurge(documentId: string): Promise<void> {
    await this.#state.storage.transaction(async (transaction) => {
      await transaction.delete(["catalog:deletion", "catalog:projection", "catalog:restoration"]);
      await transaction.put("catalog:purge", documentId);
    });
    await this.#state.storage.setAlarm(Date.now() + 2_000);
    await this.#flushCatalogOutbox();
  }

  async #flushCatalogOutbox(): Promise<boolean> {
    const workspace = workspaceStub(this.#environment);
    const purge = await this.#state.storage.get<string>("catalog:purge");
    const deletion = await this.#state.storage.get<DocumentResponse>("catalog:deletion");
    const restoration = await this.#state.storage.get<DocumentResponse>("catalog:restoration");
    const projection = await this.#state.storage.get<DocumentResponse>("catalog:projection");
    let retry = false;
    if (purge !== undefined) {
      const result = await workspace.markPurged(purge);
      if (result.ok) {
        await this.#finalizePurge();
        return true;
      }
      retry = true;
    } else if (deletion !== undefined) {
      const result = await workspace.markDeleted(deletion);
      if (result.ok) {
        await this.#state.storage.transaction(async (transaction) => {
          const pending = await transaction.get<DocumentResponse>("catalog:deletion");
          if (pending?.metadata.headRevision === deletion.metadata.headRevision) {
            await transaction.delete("catalog:deletion");
          }
        });
        await this.#scheduleTrashPurge(deletion.metadata.deletedAt);
      } else retry = true;
    } else if (restoration !== undefined) {
      const result = await workspace.markRestored(restoration);
      if (result.ok) {
        await this.#state.storage.transaction(async (transaction) => {
          const pending = await transaction.get<DocumentResponse>("catalog:restoration");
          if (pending?.metadata.headRevision === restoration.metadata.headRevision) {
            await transaction.delete("catalog:restoration");
          }
        });
      } else retry = true;
    } else if (projection !== undefined) {
      const result = await workspace.applyProjection(projection);
      if (result.ok) {
        await this.#state.storage.transaction(async (transaction) => {
          const pending = await transaction.get<DocumentResponse>("catalog:projection");
          if (
            pending !== undefined &&
            pending.metadata.headRevision <= projection.metadata.headRevision
          ) {
            await transaction.delete("catalog:projection");
          }
        });
      } else retry = true;
    }
    if (retry) await this.#state.storage.setAlarm(Date.now() + 5_000);
    return false;
  }

  async #scheduleTrashPurge(deletedAt: string | undefined): Promise<void> {
    if (deletedAt === undefined) return;
    const expiresAt = Date.parse(deletedAt) + documentTrashRetentionMilliseconds;
    await this.#state.storage.setAlarm(Math.max(Date.now() + 100, expiresAt));
  }

  async #finalizePurge(): Promise<void> {
    for (const socket of this.#state.getWebSockets()) socket.close(1001, "document_deleted");
    const runtime = this.#runtime;
    this.#runtime = undefined;
    this.#app = undefined;
    this.#configuration = undefined;
    if (runtime !== undefined) await runtime.dispose();
    await this.#state.storage.deleteAll();
  }

  #broadcast(
    message: ServerCollaborationMessage,
    excluded?: WebSocket,
  ): Effect.Effect<void, unknown> {
    return Effect.forEach(
      this.#state.getWebSockets().filter((socket) => socket !== excluded),
      (socket) => send(socket, message).pipe(Effect.catchAll(() => Effect.void)),
      { concurrency: "unbounded", discard: true },
    );
  }

  #sendSocketError(socket: WebSocket, error: unknown): Effect.Effect<void> {
    const failure =
      error instanceof ApplicationError
        ? error
        : new ApplicationError({
            cause: error,
            code: "websocket_error",
            message: "The collaboration connection failed.",
            retryable: false,
            status: 400,
          });
    return send(socket, {
      error: { code: failure.code, message: failure.message, retryable: failure.retryable },
      type: "error",
    }).pipe(
      Effect.catchAll(() => Effect.void),
      Effect.tap(() => Effect.sync(() => socket.close(4000, failure.code))),
    );
  }

  async #broadcastBodyMutation(
    request: Request,
    documentId: string,
    projection: DocumentResponse,
  ): Promise<void> {
    const runtime = this.#runtime;
    if (runtime === undefined) return this.#requestResynchronization();
    try {
      const connection = await runtime.runPromise(
        Effect.flatMap(InklingApplication, (application) =>
          application.connectCollaboration(credentials(request), documentId),
        ),
      );
      if (connection.welcome.type !== "welcome") {
        return this.#requestResynchronization();
      }
      await Effect.runPromise(
        this.#broadcast({
          clientUpdateId: `api-${connection.welcome.sequence}`,
          documentRevision: projection.metadata.headRevision,
          serverSequence: connection.welcome.sequence,
          type: "update-accepted",
          update: connection.welcome.stateUpdate,
        }).pipe(Effect.catchAll(() => Effect.void)),
      );
      if (isBodyReplacement(request.method, new URL(request.url).pathname, documentId)) {
        await Effect.runPromise(
          this.#broadcast({
            comments: projection.comments,
            revision: projection.metadata.headRevision,
            type: "comments-changed",
          }).pipe(Effect.catchAll(() => Effect.void)),
        );
      }
    } catch {
      await this.#requestResynchronization();
    }
  }

  async #requestResynchronization(): Promise<void> {
    await Effect.runPromise(
      this.#broadcast({ reason: "document_changed", type: "resynchronize" }).pipe(
        Effect.catchAll(() => Effect.void),
      ),
    );
  }
}

const worker: ExportedHandler<CloudflareEnvironment> = {
  fetch: async (request, environment) => {
    const timings = new RequestTimings(request);
    const response = await route(request, timedEnvironment(environment, timings));
    return timings.finish(request, response);
  },
};

export default worker;

async function route(request: Request, environment: CloudflareEnvironment): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === mcpEndpointPath) {
    // MCP tool calls re-enter this router so document operations reach
    // their owning document authority exactly as direct API calls do.
    return Effect.runPromise(
      handleMcpRequest(request, {
        dispatch: (inner) => route(inner, environment),
        version: "cloudflare",
      }),
    );
  }
  if (request.method === "GET" || request.method === "HEAD") {
    const location = rfcRedirectLocation(request.url);
    if (location !== undefined) {
      return new Response(null, { headers: { Location: location }, status: 308 });
    }
  }
  if (url.pathname === "/theme.css" || url.pathname === "/theme.json") {
    try {
      const theme = await Effect.runPromise(themeFromEnvironment(environment.INKLING_THEME));
      return url.pathname === "/theme.css"
        ? themeCssResponse(theme)
        : Response.json(theme ?? null, { headers: { "Cache-Control": "public, max-age=300" } });
    } catch {
      return new Response(
        url.pathname === "/theme.css"
          ? "/* INKLING_THEME is invalid. */\n"
          : JSON.stringify({ error: "INKLING_THEME is invalid." }),
        {
          headers: {
            "Cache-Control": "no-store",
            "Content-Type":
              url.pathname === "/theme.css"
                ? "text/css; charset=UTF-8"
                : "application/json; charset=UTF-8",
          },
          status: 500,
        },
      );
    }
  }
  if (url.pathname === "/api/auth/google/start") {
    return startGoogleAuthentication(request, environment);
  }
  if (url.pathname === "/api/auth/google/callback") {
    return finishGoogleAuthentication(request, environment, async (identity, people) => {
      const session = await workspaceStub(environment).loginIdentity(identity, people);
      if (!session.ok) throw new Error(session.error.message);
      return session.value;
    });
  }
  const rfcAllocationDocumentId = documentIdFromRfcAllocation(url.pathname);
  if (request.method === "POST" && rfcAllocationDocumentId !== undefined) {
    return allocateRfcNumber(request, environment, rfcAllocationDocumentId);
  }
  const documentId = documentIdFromPath(url.pathname);
  if (documentId !== undefined) {
    return dispatchDocument(request, environment, documentId);
  }
  if (/^\/rfc\/\d+$/u.test(url.pathname) && credentials(request).sessionToken !== undefined) {
    return serveApplication(request, environment);
  }
  const rfcNumber = rfcNumberFromPath(url.pathname);
  if (rfcNumber !== undefined) {
    const resolution = await workspaceStub(environment).resolvePublicRfc(rfcNumber);
    if (!resolution.ok) {
      return resolution.error.status === 404 && /^\/rfc\/\d+/u.test(url.pathname)
        ? agentResourceUnavailableResponse(request.url)
        : protocolErrorResponse(resolution.error);
    }
    return dispatchDocument(request, environment, resolution.value.documentId, resolution.value);
  }
  if (isApplicationPath(url.pathname)) {
    if (url.pathname === "/api/admin/backup" || url.pathname === "/api/admin/search/rebuild") {
      if (request.method === "POST") {
        const protectionError = mutationProtectionError(request);
        if (protectionError !== undefined) return protocolErrorResponse(protectionError);
      }
      const authorized = await workspaceStub(environment).authorize(credentials(request));
      if (!authorized.ok) return protocolErrorResponse(authorized.error);
      if (
        (authorized.value.kind !== "workspace" && authorized.value.kind !== "api-key") ||
        authorized.value.role !== "administrator"
      ) {
        return protocolErrorResponse({
          code: "forbidden",
          message: "Workspace administrator access is required.",
          retryable: false,
          status: 403,
        });
      }
      const flushed = await flushDocumentsForBackup(environment);
      if (!flushed.ok) return protocolErrorResponse(flushed.error);
    }
    return workspaceStub(environment).fetch(request);
  }
  return serveApplication(request, environment);
}

/**
 * Serves application pages rendered on the server and every other path from
 * the static assets. Rendering loads the page's data through this router, as
 * the browser would, without leaving the Worker.
 */
async function serveApplication(
  request: Request,
  environment: CloudflareEnvironment,
): Promise<Response> {
  if (request.method === "GET" || request.method === "HEAD") {
    const template = await applicationTemplate(request, environment);
    const page =
      template === undefined
        ? undefined
        : renderApplication({
            fetch: (inner) => route(inner, environment),
            request,
            template,
          });
    if (page !== undefined) return page;
  }
  const response = await environment.ASSETS.fetch(request);
  const cacheControl = response.ok
    ? staticAssetCacheControl(new URL(request.url).pathname)
    : undefined;
  return cacheControl === undefined
    ? response
    : withHeader(response, "Cache-Control", cacheControl);
}

let templatePromise: Promise<string | undefined> | undefined;

/** The built application shell; assets only change with a deployment, so isolates keep it. */
function applicationTemplate(
  request: Request,
  environment: CloudflareEnvironment,
): Promise<string | undefined> {
  templatePromise ??= environment.ASSETS.fetch(new Request(new URL("/", request.url)))
    .then((response) => (response.ok ? response.text() : undefined))
    .catch(() => undefined)
    .then((template) => {
      if (template === undefined) templatePromise = undefined;
      return template;
    });
  return templatePromise;
}

function withHeader(response: Response, name: string, value: string): Response {
  const copy = new Response(response.body, response);
  copy.headers.set(name, value);
  return copy;
}

function themeFromEnvironment(
  value: string | undefined,
): Effect.Effect<ThemeConfiguration | undefined, ThemeError> {
  const selected = value?.trim();
  if (isDefaultThemeSelection(selected)) return Effect.succeed(undefined);
  const bundled = findBundledTheme(selected);
  return bundled === undefined ? decodeThemeJson(selected ?? "") : Effect.succeed(bundled);
}

async function flushDocumentsForBackup(
  environment: CloudflareEnvironment,
): Promise<RpcResult<boolean>> {
  const configurations = await workspaceStub(environment).configurations();
  if (!configurations.ok) return configurations;
  const results = await Promise.all(
    configurations.value.map(async (configuration): Promise<RpcResult<boolean>> => {
      const document = environment.INKLING_DOCUMENTS.get(
        environment.INKLING_DOCUMENTS.idFromName(configuration.documentId),
      );
      const initialized = await document.initialize(configuration);
      return initialized.ok ? document.flush() : initialized;
    }),
  );
  return results.find((result) => !result.ok) ?? { ok: true, value: true };
}

/**
 * Times one request's calls to the Durable Objects. API responses carry the
 * result in a Server-Timing header; server-rendered pages stream before
 * their data loads, so every request with such calls is also logged once
 * its body is complete.
 */
class RequestTimings {
  readonly #colo: string | undefined;
  readonly #entries: string[] = [];
  readonly #started = performance.now();
  #calls = 0;

  constructor(request: Request) {
    const colo = (request.cf as { readonly colo?: unknown } | undefined)?.colo;
    this.#colo = typeof colo === "string" ? colo : undefined;
  }

  /** Records a call; its description names the method and when it started, to show overlap. */
  record(hop: string, method: string, started: number): void {
    this.#calls += 1;
    const offset = (started - this.#started).toFixed(0);
    const duration = (performance.now() - started).toFixed(1);
    this.#entries.push(`${hop};desc="${method} +${offset}ms";dur=${duration}`);
  }

  /** Keeps the time a Durable Object reported for itself under the hop's name. */
  absorb(hop: string, response: Response): void {
    const reported = response.headers.get("Server-Timing");
    if (reported === null) return;
    for (const metric of reported.split(",")) {
      const trimmed = metric.trim();
      if (trimmed.length > 0) this.#entries.push(`${hop}-${trimmed}`);
    }
  }

  header(): string {
    return [
      ...(this.#colo === undefined ? [] : [`edge;desc="${this.#colo}"`]),
      ...this.#entries,
      `total;dur=${(performance.now() - this.#started).toFixed(1)}`,
    ].join(", ");
  }

  finish(request: Request, response: Response): Response {
    if (response.status === 101 || response.webSocket !== null) {
      this.#log(request, response.status);
      return response;
    }
    if (response.body !== null && response.headers.get("Content-Type")?.startsWith("text/html")) {
      const log = () => this.#log(request, response.status);
      const body = response.body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({ flush: log }),
      );
      return new Response(body, response);
    }
    this.#log(request, response.status);
    return withHeader(response, "Server-Timing", this.header());
  }

  #log(request: Request, status: number): void {
    if (this.#calls === 0) return;
    console.log(
      JSON.stringify({
        event: "request_timing",
        method: request.method,
        path: new URL(request.url).pathname,
        status,
        timing: this.header(),
      }),
    );
  }
}

/** Cold starts load state from storage; their duration shows what a first request waits for. */
function logStartup(authority: "document" | "workspace", durationMs: number): void {
  console.log(JSON.stringify({ authority, durationMs, event: "authority_started" }));
}

/** The environment with Durable Object bindings whose calls are timed. */
function timedEnvironment(
  environment: CloudflareEnvironment,
  timings: RequestTimings,
): CloudflareEnvironment {
  const documents = timedNamespace(environment.INKLING_DOCUMENTS, "document", timings);
  const workspace = timedNamespace(environment.INKLING_WORKSPACE, "workspace", timings);
  // Bindings and variables are not all enumerable, so the environment is
  // wrapped rather than copied.
  return new Proxy(environment, {
    get(target, property) {
      if (property === "INKLING_DOCUMENTS") return documents;
      if (property === "INKLING_WORKSPACE") return workspace;
      return Reflect.get(target, property, target);
    },
  });
}

function timedNamespace<T extends object>(namespace: T, hop: string, timings: RequestTimings): T {
  return new Proxy(namespace, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      if (property !== "get") return value.bind(target);
      return (...args: unknown[]) =>
        timedStub(Reflect.apply(value, target, args) as object, hop, timings);
    },
  });
}

function timedStub<T extends object>(stub: T, hop: string, timings: RequestTimings): T {
  return new Proxy(stub, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof property !== "string" || typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        const started = performance.now();
        try {
          // RPC methods are stubs too: `value.apply` would call a remote "apply".
          const result: unknown = await Reflect.apply(value, target, args);
          if (result instanceof Response) timings.absorb(hop, result);
          return result;
        } finally {
          timings.record(hop, property, started);
        }
      };
    },
  });
}

/** Marks the internal answer of a document authority that was never initialized. */
const uninitializedDocumentHeader = "X-Inkling-Document-Uninitialized";

async function dispatchDocument(
  request: Request,
  environment: CloudflareEnvironment,
  documentId: string,
  knownConfiguration?: DocumentRuntimeConfiguration,
): Promise<Response> {
  // An initialized authority answers reads by itself and authorizes them
  // with the workspace; asking the workspace for its configuration first
  // only adds a round trip. Writes keep the configuration check, and reads
  // fall back to it when the authority has never been initialized.
  if (
    knownConfiguration === undefined &&
    (request.method === "GET" || request.method === "HEAD") &&
    /^[A-Za-z0-9_-]{10,128}$/u.test(documentId)
  ) {
    const response = await environment.INKLING_DOCUMENTS.get(
      environment.INKLING_DOCUMENTS.idFromName(documentId),
    ).fetch(request);
    if (response.headers.get(uninitializedDocumentHeader) === null) return response;
  }
  const configurationResult =
    knownConfiguration === undefined
      ? await workspaceStub(environment).configuration(documentId)
      : ({ ok: true, value: knownConfiguration } as const);
  if (!configurationResult.ok) {
    const permanentPath = `/api/documents/${encodeURIComponent(documentId)}/permanent`;
    if (request.method === "DELETE" && new URL(request.url).pathname === permanentPath) {
      const protectionError = mutationProtectionError(request);
      if (protectionError !== undefined) return protocolErrorResponse(protectionError);
      const authorized = await workspaceStub(environment).authorize(
        credentials(request),
        documentId,
      );
      if (!authorized.ok) return protocolErrorResponse(authorized.error);
      // Administrators and owners of personal documents purge; a retry after
      // the purge succeeds for either, since the owner is no longer known.
      if (authorized.value.kind === "workspace" || authorized.value.kind === "api-key") {
        return Response.json({}, { headers: { "Cache-Control": "no-store" } });
      }
    }
    return protocolErrorResponse(configurationResult.error);
  }
  const document = environment.INKLING_DOCUMENTS.get(
    environment.INKLING_DOCUMENTS.idFromName(documentId),
  );
  const initialized = await document.initialize(configurationResult.value);
  return initialized.ok ? document.fetch(request) : protocolErrorResponse(initialized.error);
}

async function allocateRfcNumber(
  request: Request,
  environment: CloudflareEnvironment,
  documentId: string,
): Promise<Response> {
  const protectionError = mutationProtectionError(request);
  if (protectionError !== undefined) return protocolErrorResponse(protectionError);

  const workspace = workspaceStub(environment);
  const requestCredentials = credentials(request);
  const allocation = await workspace.reserveRfcNumber(requestCredentials, documentId);
  if (!allocation.ok) return protocolErrorResponse(allocation.error);
  const configuration = await workspace.configuration(documentId);
  if (!configuration.ok) return protocolErrorResponse(configuration.error);

  const document = environment.INKLING_DOCUMENTS.get(
    environment.INKLING_DOCUMENTS.idFromName(documentId),
  );
  const initialized = await document.initialize(configuration.value);
  if (!initialized.ok) return protocolErrorResponse(initialized.error);
  const assigned = await document.assignRfcNumber(requestCredentials, documentId, allocation.value);
  if (!assigned.ok) return protocolErrorResponse(assigned.error);
  return Response.json(assigned.value, { headers: { "Cache-Control": "no-store" } });
}

function createApplicationRuntime(
  state: DurableObjectState,
  environment: CloudflareEnvironment,
  options: LocalApplicationOptions,
  search: "disabled" | "workspace",
): ManagedRuntimeType.ManagedRuntime<InklingApplicationService, never> {
  const storage = Layer.mergeAll(
    Layer.succeed(WorkspaceStateStore, makeDurableWorkspaceStateStore(state.storage)),
    Layer.succeed(ObjectStore, makeR2ObjectStore(environment.INKLING_OBJECTS)),
    Layer.succeed(DurableDocumentJournal, makeDurableObjectJournal(state.storage)),
    search === "workspace"
      ? workspaceSearchIndexLayer(state, environment)
      : DisabledSearchIndexLive,
  );
  const dependencies = Layer.mergeAll(
    storage,
    DigestLive,
    SecureTokenLive,
    TokenHasherLive,
    CloudflareSecretHasherLive,
    TokenHasherLive,
    IdGeneratorLive,
    MarkdownRendererLive,
  );
  const application = localApplicationLayer(options).pipe(Layer.provide(dependencies), Layer.orDie);
  return ManagedRuntime.make(application);
}

/** Search lives in the workspace authority, which already receives every projection. */
function workspaceSearchIndexLayer(state: DurableObjectState, environment: CloudflareEnvironment) {
  const ai = environment.AI;
  const vectors = environment.INKLING_VECTORS;
  return Layer.effect(
    SearchIndex,
    makeSqlSearchIndex({
      database: makeDurableObjectSearchDatabase(state.storage),
      digest: WebCryptoDigest,
      semantic:
        ai === undefined || vectors === undefined
          ? undefined
          : {
              embedder: makeWorkersAiEmbedder(
                ai,
                environment.INKLING_EMBEDDING_MODEL?.trim() || defaultEmbeddingModel,
              ),
              vectors: makeVectorizeStore(vectors),
            },
    }),
  );
}

function semanticSearchConfigured(environment: CloudflareEnvironment): boolean {
  return environment.AI !== undefined && environment.INKLING_VECTORS !== undefined;
}

function isolatedWorkspaceState(configuration: DocumentRuntimeConfiguration): unknown {
  return {
    attachments: {},
    authentication: { apiKeys: [], sessions: [] },
    capabilities: configuration.capabilities,
    catalog: {
      entries: [
        {
          creationKey: `cloudflare:${configuration.documentId}`,
          documentId: configuration.documentId,
          rfcNumber: configuration.rfcNumber,
          status: "active",
          summary: configuration.summary,
        },
      ],
      nextRfcNumber: (configuration.rfcNumber ?? 0) + 1,
      people: [],
    },
    schemaVersion: 1,
    workspaceId: configuration.workspaceId,
  };
}

const catalogProjectionIntervalMilliseconds = 2_000;
const principalCacheMilliseconds = 30_000;
const maximumCachedPrincipals = 256;

/** Only signed-in credentials are cached; capabilities are verified by the document itself. */
function principalCacheKey(
  requestCredentials: RequestCredentials,
  documentId: string | undefined,
): string | undefined {
  const { bearerToken, capabilityToken, sessionToken } = requestCredentials;
  if (capabilityToken !== undefined) return undefined;
  if (bearerToken === undefined && sessionToken === undefined) return undefined;
  return JSON.stringify([documentId ?? null, bearerToken ?? null, sessionToken ?? null]);
}

function workspaceStub(environment: CloudflareEnvironment) {
  return environment.INKLING_WORKSPACE.get(environment.INKLING_WORKSPACE.idFromName("primary"));
}

function runRpc<A>(
  runtime: ManagedRuntimeType.ManagedRuntime<InklingApplicationService, never>,
  effect: Effect.Effect<A, ApplicationError, InklingApplicationService>,
): Promise<RpcResult<A>> {
  return runtime.runPromise(
    effect.pipe(
      Effect.match({
        onFailure: (error): RpcResult<A> => ({
          error: {
            code: error.code,
            message: error.message,
            retryable: error.retryable,
            status: error.status,
          },
          ok: false,
        }),
        onSuccess: (value): RpcResult<A> => ({ ok: true, value }),
      }),
    ),
  );
}

function callRpc<A>(promise: Promise<RpcResult<A>>): Effect.Effect<A, ApplicationError> {
  return Effect.tryPromise({
    catch: (cause) =>
      new ApplicationError({
        cause,
        code: "coordinator_unavailable",
        message: "The workspace coordinator is unavailable.",
        retryable: true,
        status: 503,
      }),
    try: () => promise,
  }).pipe(
    Effect.flatMap((result) =>
      result.ok
        ? Effect.succeed(result.value)
        : Effect.fail(
            new ApplicationError({
              code: result.error.code,
              message: result.error.message,
              retryable: result.error.retryable,
              status: applicationStatus(result.error.status),
            }),
          ),
    ),
  );
}

function applicationStatus(value: number): ApplicationError["status"] {
  return new Set([400, 401, 403, 404, 409, 413, 429, 500, 503]).has(value)
    ? (value as ApplicationError["status"])
    : 500;
}

function decodeSocketMessage(
  message: string | ArrayBuffer,
): Effect.Effect<ClientCollaborationMessage, unknown> {
  const text = typeof message === "string" ? message : new TextDecoder().decode(message);
  if (text.length > 1_200_000) {
    return protocolFailure("message_too_large", "The collaboration message is too large.");
  }
  return decodeJson(ClientCollaborationMessageSchema, text);
}

function send(
  socket: WebSocket,
  message: ServerCollaborationMessage,
): Effect.Effect<void, unknown> {
  return encodeJson(ServerCollaborationMessageSchema, message).pipe(
    Effect.flatMap((text) =>
      Effect.try({
        catch: (cause) => cause,
        try: () => socket.send(text),
      }),
    ),
  );
}

function protocolFailure(code: string, message: string): Effect.Effect<never, ApplicationError> {
  return Effect.fail(new ApplicationError({ code, message, retryable: false, status: 400 }));
}

function protocolErrorResponse(error: RpcError): Response {
  return Response.json(
    { code: error.code, message: error.message, retryable: error.retryable },
    { status: error.status },
  );
}

function credentials(request: Request): RequestCredentials {
  const url = new URL(request.url);
  const authorization = request.headers.get("Authorization");
  const capabilityToken = url.searchParams.get("cap") ?? undefined;
  const cookies = parseCookies(request.headers.get("Cookie"));
  const proofCookieName = shareProofCookieNameFromToken(capabilityToken);
  return {
    bearerToken: authorization?.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length)
      : undefined,
    capabilityProof: proofCookieName === undefined ? undefined : cookies[proofCookieName],
    capabilityToken,
    guestName:
      request.headers.get("X-Inkling-Guest-Name") ?? url.searchParams.get("guest") ?? undefined,
    sessionToken: cookies["inkling_session"],
  };
}

function parseCookies(header: string | null): Readonly<Record<string, string>> {
  if (header === null) return {};
  return Object.fromEntries(
    header.split(";").flatMap((part) => {
      const separator = part.indexOf("=");
      if (separator === -1) return [];
      return [[part.slice(0, separator).trim(), part.slice(separator + 1).trim()]];
    }),
  );
}

function documentIdFromPath(pathname: string): string | undefined {
  const document =
    /^\/(?:api\/documents|api\/public\/documents|public\/documents)\/([^/]+)(?:\/|$)/u.exec(
      pathname,
    );
  const protectedLink = /^\/auth\/(?:link|reference)\/([^/]+)\/\d+\/\d+\/?$/u.exec(pathname);
  const rawDocumentId = document?.[1] ?? protectedLink?.[1];
  if (rawDocumentId === undefined) return undefined;
  try {
    return decodeURIComponent(rawDocumentId);
  } catch {
    return undefined;
  }
}

function documentIdFromRfcAllocation(pathname: string): string | undefined {
  const match = /^\/api\/documents\/([^/]+)\/rfc$/u.exec(pathname);
  if (match?.[1] === undefined) return undefined;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return undefined;
  }
}

function rfcNumberFromPath(pathname: string): number | undefined {
  const api = /^\/api\/public\/rfc\/(\d+)\/?$/u.exec(pathname);
  const canonical = /^\/rfc\/(\d+)$/u.exec(pathname);
  const value = Number(api?.[1] ?? canonical?.[1]);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function isSameOrigin(origin: string | null, requestUrl: string): boolean {
  if (origin === null) return false;
  try {
    const parsedOrigin = new URL(origin);
    const parsedRequest = new URL(requestUrl);
    return (
      (parsedOrigin.protocol === "http:" || parsedOrigin.protocol === "https:") &&
      parsedOrigin.host === parsedRequest.host
    );
  } catch {
    return false;
  }
}

function isMutation(request: Request): boolean {
  return request.method !== "GET" && request.method !== "HEAD" && request.method !== "OPTIONS";
}

function isBodyMutation(method: string, pathname: string, documentId: string): boolean {
  const base = `/api/documents/${encodeURIComponent(documentId)}`;
  const suffix = pathname.startsWith(base) ? pathname.slice(base.length) : "";
  return (
    (method === "POST" && (suffix === "/edits" || /^\/history\/\d+\/restore$/u.test(suffix))) ||
    (method === "PUT" && suffix === "/body")
  );
}

function isBodyReplacement(method: string, pathname: string, documentId: string): boolean {
  const base = `/api/documents/${encodeURIComponent(documentId)}`;
  const suffix = pathname.startsWith(base) ? pathname.slice(base.length) : "";
  return (
    (method === "POST" && /^\/history\/\d+\/restore$/u.test(suffix)) ||
    (method === "PUT" && suffix === "/body")
  );
}

function isPublicationMutation(pathname: string, documentId: string): boolean {
  const base = `/api/documents/${encodeURIComponent(documentId)}`;
  return pathname === `${base}/publish` || pathname === `${base}/unpublish`;
}

function mutationProtectionError(request: Request): RpcError | undefined {
  const requestCredentials = credentials(request);
  if (
    requestCredentials.sessionToken === undefined ||
    requestCredentials.bearerToken !== undefined
  ) {
    return undefined;
  }
  const csrfCookie = parseCookies(request.headers.get("Cookie"))["inkling_csrf"];
  const csrfHeader = request.headers.get("X-CSRF-Token");
  return isSameOrigin(request.headers.get("Origin"), request.url) &&
    csrfHeader !== null &&
    csrfHeader === csrfCookie
    ? undefined
    : {
        code: "csrf_rejected",
        message: "The mutation failed origin or CSRF validation.",
        retryable: false,
        status: 403,
      };
}

function isApplicationPath(pathname: string): boolean {
  return (
    isOAuthPath(pathname) ||
    pathname === "/api" ||
    pathname.startsWith("/api/") ||
    pathname.startsWith("/state/") ||
    pathname.startsWith("/keyword/")
  );
}
