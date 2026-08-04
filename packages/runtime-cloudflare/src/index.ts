import { DurableObject } from "cloudflare:workers";
import { Effect, Layer, ManagedRuntime } from "effect";
import type { ManagedRuntime as ManagedRuntimeType } from "effect";

import { DurableDocumentJournal, ObjectStore, WorkspaceStateStore } from "@earendil-works/jot-core";
import type { Principal } from "@earendil-works/jot-core";
import {
  ApplicationError,
  createBackendApp,
  DigestLive,
  IdGeneratorLive,
  JotApplication,
  localApplicationLayer,
  SecretHasherLive,
  SecureTokenLive,
} from "@earendil-works/jot-backend";
import type {
  DocumentRuntimeConfiguration,
  JotApplicationService,
  LocalApplicationOptions,
  RequestCredentials,
} from "@earendil-works/jot-backend";
import { decodeBase64 } from "@earendil-works/jot-collaboration";
import {
  ClientCollaborationMessageSchema,
  decodeJson,
  encodeJson,
  ServerCollaborationMessageSchema,
} from "@earendil-works/jot-protocol";
import type {
  ClientCollaborationMessage,
  DocumentResponse,
  ServerCollaborationMessage,
} from "@earendil-works/jot-protocol";
import { MarkdownRendererLive } from "@earendil-works/jot-renderer";

import {
  makeDurableObjectJournal,
  makeDurableWorkspaceStateStore,
  makeR2ObjectStore,
} from "./storage.ts";

export interface CloudflareEnvironment {
  readonly ASSETS: Fetcher;
  readonly JOT_DOCUMENTS: DurableObjectNamespace<DocumentDurableObject>;
  readonly JOT_OBJECTS: R2Bucket;
  readonly JOT_WORKSPACE: DurableObjectNamespace<WorkspaceDurableObject>;
}

interface SocketAttachment {
  readonly credentials: RequestCredentials;
  readonly documentId: string;
  readonly initialized: boolean;
  readonly principal?: Principal | undefined;
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
  readonly #runtime: ManagedRuntimeType.ManagedRuntime<JotApplicationService, never>;
  readonly #app: ReturnType<typeof createBackendApp>;

  constructor(state: DurableObjectState, environment: CloudflareEnvironment) {
    super(state, environment);
    this.#state = state;
    this.#runtime = createApplicationRuntime(state, environment, {
      ownsDocumentPrivateState: false,
      workspaceId: state.id.toString(),
    });
    this.#app = createBackendApp({ runtime: this.#runtime, version: "cloudflare" });
    state.blockConcurrencyWhile(() => this.#runtime.runtime().then(() => undefined));
  }

  override async fetch(request: Request): Promise<Response> {
    const response = await this.#app.fetch(request);
    if (isMutation(request) && response.ok) {
      await this.#state.storage.setAlarm(Date.now() + 2_000);
    }
    return response;
  }

  override async alarm(): Promise<void> {
    await this.#runtime.runPromise(
      Effect.flatMap(JotApplication, (application) => application.checkpointAll()),
    );
  }

  async authorize(
    requestCredentials: RequestCredentials,
    documentId?: string,
  ): Promise<RpcResult<Principal>> {
    return runRpc(
      this.#runtime,
      Effect.flatMap(JotApplication, (application) =>
        application.authorizeRequest(requestCredentials, documentId),
      ),
    );
  }

  async configuration(documentId: string): Promise<RpcResult<DocumentRuntimeConfiguration>> {
    return runRpc(
      this.#runtime,
      Effect.flatMap(JotApplication, (application) =>
        application
          .checkpointAll()
          .pipe(Effect.zipRight(application.documentRuntimeConfiguration(documentId))),
      ),
    );
  }

  async applyProjection(document: DocumentResponse): Promise<RpcResult<boolean>> {
    return runRpc(
      this.#runtime,
      Effect.flatMap(JotApplication, (application) =>
        application.applyDocumentProjection(document).pipe(Effect.as(true)),
      ),
    );
  }

  async markDeleted(documentId: string): Promise<RpcResult<boolean>> {
    return runRpc(
      this.#runtime,
      Effect.flatMap(JotApplication, (application) =>
        application.markCatalogDeleted(documentId).pipe(Effect.as(true)),
      ),
    );
  }

  async resolvePublicRfc(rfcNumber: number): Promise<RpcResult<DocumentRuntimeConfiguration>> {
    return runRpc(
      this.#runtime,
      Effect.flatMap(JotApplication, (application) =>
        application.listPublicDocuments("").pipe(
          Effect.flatMap((catalog) => {
            const document = catalog.documents.find(
              (candidate) => candidate.metadata.rfcNumber === rfcNumber,
            );
            return document === undefined
              ? Effect.fail(
                  new ApplicationError({
                    code: "not_found",
                    message: "The published RFC does not exist.",
                    retryable: false,
                    status: 404,
                  }),
                )
              : application.documentRuntimeConfiguration(document.metadata.id);
          }),
        ),
      ),
    );
  }
}

/** One hibernating collaboration and command authority per document. */
export class DocumentDurableObject extends DurableObject<CloudflareEnvironment> {
  readonly #state: DurableObjectState;
  readonly #environment: CloudflareEnvironment;
  #runtime: ManagedRuntimeType.ManagedRuntime<JotApplicationService, never> | undefined;
  #app: ReturnType<typeof createBackendApp> | undefined;
  #configuration: DocumentRuntimeConfiguration | undefined;

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

  override async fetch(request: Request): Promise<Response> {
    const configuration = await this.#loadConfiguration();
    if (configuration === undefined) {
      return protocolErrorResponse({
        code: "document_not_initialized",
        message: "The document authority has not been initialized.",
        retryable: true,
        status: 503,
      });
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
      return this.#upgrade(request, decodeURIComponent(match[1]));
    }

    const response = await app.fetch(request);
    if (isMutation(request) && response.ok) {
      const pending =
        request.method === "DELETE" &&
        url.pathname === `/api/documents/${encodeURIComponent(configuration.documentId)}`
          ? this.#queueDeletion(configuration.documentId)
          : runtime
              .runPromise(
                Effect.flatMap(JotApplication, (application) =>
                  application.currentDocumentProjection(configuration.documentId),
                ),
              )
              .then((projection) => this.#queueProjection(projection));
      this.#state.waitUntil(pending);
      await this.#requestResynchronization();
    }
    return response;
  }

  override async alarm(): Promise<void> {
    const configuration = await this.#loadConfiguration();
    if (configuration === undefined) return;
    await this.#ensureRuntime(configuration);
    const runtime = this.#runtime;
    if (runtime !== undefined) {
      await runtime.runPromise(
        Effect.flatMap(JotApplication, (application) => application.checkpointAll()),
      );
      await this.#flushCatalogOutbox();
    }
  }

  override async webSocketMessage(
    socket: WebSocket,
    rawMessage: string | ArrayBuffer,
  ): Promise<void> {
    const attachment = socket.deserializeAttachment() as SocketAttachment | null;
    const runtime = this.#runtime;
    if (attachment === null || runtime === undefined) {
      socket.close(4000, "missing_document_runtime");
      return;
    }
    const processed = decodeSocketMessage(rawMessage).pipe(
      Effect.flatMap((message) => this.#processSocketMessage(socket, attachment, message)),
      Effect.catchAll((error) => this.#sendSocketError(socket, error)),
    );
    await runtime.runPromise(processed);
  }

  override webSocketClose(): void {}

  override webSocketError(): void {}

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
    ) => callRpc(workspaceStub(this.#environment).authorize(requestCredentials, documentId));
    const runtime = createApplicationRuntime(this.#state, this.#environment, {
      principalResolver: resolver,
      workspaceId: configuration.workspaceId,
    });
    await runtime.runtime();
    this.#configuration = configuration;
    this.#runtime = runtime;
    this.#app = createBackendApp({ runtime, version: "cloudflare-document" });
  }

  #upgrade(request: Request, documentId: string): Response {
    if (!isSameOrigin(request.headers.get("Origin"), request.url)) {
      return new Response("WebSocket origin rejected.", { status: 403 });
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const attachment: SocketAttachment = {
      credentials: credentials(request),
      documentId,
      initialized: false,
    };
    server.serializeAttachment(attachment);
    this.#state.acceptWebSocket(server, [documentId]);
    return new Response(null, { status: 101, webSocket: client });
  }

  #processSocketMessage(
    socket: WebSocket,
    attachment: SocketAttachment,
    message: ClientCollaborationMessage,
  ): Effect.Effect<void, unknown, JotApplicationService> {
    return Effect.gen(this, function* () {
      const application = yield* JotApplication;
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
        const connection = yield* application.connectCollaboration(
          { internalPrincipal: attachment.principal },
          attachment.documentId,
        );
        const update = yield* decodeBase64(message.update);
        const accepted = yield* connection.acceptUpdate(update, message.clientUpdateId);
        yield* this.#broadcast(accepted);
        yield* Effect.tryPromise({
          catch: (cause) => cause,
          try: () => this.#state.storage.setAlarm(Date.now() + 2_000),
        });
        const projection = yield* application.currentDocumentProjection(attachment.documentId);
        yield* Effect.sync(() => {
          this.#state.waitUntil(this.#queueProjection(projection));
        });
        return;
      }

      if (message.type === "presence") {
        yield* this.#broadcast({ presence: message.presence, type: "presence" }, socket);
      }
    });
  }

  async #queueProjection(projection: DocumentResponse): Promise<void> {
    await this.#state.storage.put("catalog:projection", projection);
    await this.#state.storage.setAlarm(Date.now() + 2_000);
    await this.#flushCatalogOutbox();
  }

  async #queueDeletion(documentId: string): Promise<void> {
    await this.#state.storage.put("catalog:deletion", documentId);
    await this.#state.storage.setAlarm(Date.now() + 2_000);
    await this.#flushCatalogOutbox();
  }

  async #flushCatalogOutbox(): Promise<void> {
    const workspace = workspaceStub(this.#environment);
    const deletion = await this.#state.storage.get<string>("catalog:deletion");
    const projection = await this.#state.storage.get<DocumentResponse>("catalog:projection");
    let retry = false;
    if (deletion !== undefined) {
      const result = await workspace.markDeleted(deletion);
      if (result.ok) await this.#state.storage.delete("catalog:deletion");
      else retry = true;
    }
    if (projection !== undefined) {
      const result = await workspace.applyProjection(projection);
      if (result.ok) await this.#state.storage.delete("catalog:projection");
      else retry = true;
    }
    if (retry) await this.#state.storage.setAlarm(Date.now() + 5_000);
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

  async #requestResynchronization(): Promise<void> {
    await Effect.runPromise(
      this.#broadcast({ reason: "document_changed", type: "resynchronize" }).pipe(
        Effect.catchAll(() => Effect.void),
      ),
    );
  }
}

const worker: ExportedHandler<CloudflareEnvironment> = {
  async fetch(request, environment) {
    const url = new URL(request.url);
    const documentId = documentIdFromPath(url.pathname);
    if (documentId !== undefined) {
      return dispatchDocument(request, environment, documentId);
    }
    const rfcNumber = rfcNumberFromPath(url.pathname);
    if (rfcNumber !== undefined) {
      const resolution = await workspaceStub(environment).resolvePublicRfc(rfcNumber);
      if (!resolution.ok) return protocolErrorResponse(resolution.error);
      return dispatchDocument(request, environment, resolution.value.documentId, resolution.value);
    }
    if (isApplicationPath(url.pathname)) {
      return workspaceStub(environment).fetch(request);
    }
    return environment.ASSETS.fetch(request);
  },
};

export default worker;

async function dispatchDocument(
  request: Request,
  environment: CloudflareEnvironment,
  documentId: string,
  knownConfiguration?: DocumentRuntimeConfiguration,
): Promise<Response> {
  const configurationResult =
    knownConfiguration === undefined
      ? await workspaceStub(environment).configuration(documentId)
      : ({ ok: true, value: knownConfiguration } as const);
  if (!configurationResult.ok) return protocolErrorResponse(configurationResult.error);
  const document = environment.JOT_DOCUMENTS.get(environment.JOT_DOCUMENTS.idFromName(documentId));
  const initialized = await document.initialize(configurationResult.value);
  return initialized.ok ? document.fetch(request) : protocolErrorResponse(initialized.error);
}

function createApplicationRuntime(
  state: DurableObjectState,
  environment: CloudflareEnvironment,
  options: LocalApplicationOptions,
): ManagedRuntimeType.ManagedRuntime<JotApplicationService, never> {
  const storage = Layer.mergeAll(
    Layer.succeed(WorkspaceStateStore, makeDurableWorkspaceStateStore(state.storage)),
    Layer.succeed(ObjectStore, makeR2ObjectStore(environment.JOT_OBJECTS)),
    Layer.succeed(DurableDocumentJournal, makeDurableObjectJournal(state.storage)),
  );
  const identifiers = IdGeneratorLive.pipe(Layer.provide(SecureTokenLive));
  const dependencies = Layer.mergeAll(
    storage,
    DigestLive,
    SecureTokenLive,
    SecretHasherLive,
    identifiers,
    MarkdownRendererLive,
  );
  const application = localApplicationLayer(options).pipe(Layer.provide(dependencies), Layer.orDie);
  return ManagedRuntime.make(application);
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

function workspaceStub(environment: CloudflareEnvironment) {
  return environment.JOT_WORKSPACE.get(environment.JOT_WORKSPACE.idFromName("primary"));
}

function runRpc<A>(
  runtime: ManagedRuntimeType.ManagedRuntime<JotApplicationService, never>,
  effect: Effect.Effect<A, ApplicationError, JotApplicationService>,
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
  return {
    bearerToken: authorization?.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length)
      : undefined,
    capabilityToken: url.searchParams.get("cap") ?? undefined,
    guestName:
      request.headers.get("X-Jot-Guest-Name") ?? url.searchParams.get("guest") ?? undefined,
    sessionToken: parseCookies(request.headers.get("Cookie"))["jot_session"],
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
  const match = /^\/api\/documents\/([^/]+)(?:\/|$)/u.exec(pathname);
  return match?.[1] === undefined ? undefined : decodeURIComponent(match[1]);
}

function rfcNumberFromPath(pathname: string): number | undefined {
  const match = /^\/(?:api\/public\/)?rfc\/(\d+)(?:\/|$)/u.exec(pathname);
  const value = Number(match?.[1]);
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

function isApplicationPath(pathname: string): boolean {
  return (
    pathname === "/api" ||
    pathname.startsWith("/api/") ||
    pathname.startsWith("/state/") ||
    pathname.startsWith("/keyword/")
  );
}
