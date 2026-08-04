import { DurableObject } from "cloudflare:workers";
import { Effect, Layer, ManagedRuntime } from "effect";
import type { ManagedRuntime as ManagedRuntimeType } from "effect";

import { DurableDocumentJournal, ObjectStore, WorkspaceStateStore } from "@earendil-works/jot-core";
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
import type { JotApplicationService, RequestCredentials } from "@earendil-works/jot-backend";
import { decodeBase64 } from "@earendil-works/jot-collaboration";
import {
  ClientCollaborationMessageSchema,
  decodeJson,
  encodeJson,
  ServerCollaborationMessageSchema,
} from "@earendil-works/jot-protocol";
import type {
  ClientCollaborationMessage,
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
  readonly JOT_OBJECTS: R2Bucket;
  readonly JOT_WORKSPACE: DurableObjectNamespace<WorkspaceDurableObject>;
}

interface SocketAttachment {
  readonly credentials: RequestCredentials;
  readonly documentId: string;
  readonly initialized: boolean;
}

/**
 * Workspace coordinator for the Cloudflare deployment. Durable Object storage
 * serializes catalog/authentication writes while R2 stores immutable document
 * checkpoints and publication revisions.
 */
export class WorkspaceDurableObject extends DurableObject<CloudflareEnvironment> {
  readonly #state: DurableObjectState;
  readonly #runtime: ManagedRuntimeType.ManagedRuntime<JotApplicationService, never>;
  readonly #app: ReturnType<typeof createBackendApp>;

  constructor(state: DurableObjectState, environment: CloudflareEnvironment) {
    super(state, environment);
    this.#state = state;
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
    const application = localApplicationLayer({ workspaceId: state.id.toString() }).pipe(
      Layer.provide(dependencies),
      Layer.orDie,
    );
    this.#runtime = ManagedRuntime.make(application);
    this.#app = createBackendApp({ runtime: this.#runtime, version: "cloudflare" });
    state.blockConcurrencyWhile(() => this.#runtime.runtime().then(() => undefined));
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const match = /^\/api\/documents\/([^/]+)\/ws$/u.exec(url.pathname);
    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket" && match?.[1] !== undefined) {
      return this.#upgrade(request, decodeURIComponent(match[1]));
    }

    const response = await this.#app.fetch(request);
    if (isMutation(request) && response.ok) {
      await this.#state.storage.setAlarm(Date.now() + 2_000);
      await this.#requestResynchronization();
    }
    return response;
  }

  override async alarm(): Promise<void> {
    await this.#runtime.runPromise(
      Effect.flatMap(JotApplication, (application) => application.checkpointAll()),
    );
  }

  override async webSocketMessage(
    socket: WebSocket,
    rawMessage: string | ArrayBuffer,
  ): Promise<void> {
    const attachment = socket.deserializeAttachment() as SocketAttachment | null;
    if (attachment === null) {
      socket.close(4000, "missing_attachment");
      return;
    }
    const processed = decodeSocketMessage(rawMessage).pipe(
      Effect.flatMap((message) => this.#processSocketMessage(socket, attachment, message)),
      Effect.catchAll((error) => this.#sendSocketError(socket, error)),
    );
    await this.#runtime.runPromise(processed);
  }

  override webSocketClose(): void {}

  override webSocketError(): void {}

  #upgrade(request: Request, documentId: string): Response {
    const origin = request.headers.get("Origin");
    if (!isSameOrigin(origin, request.url)) {
      return new Response("WebSocket origin rejected.", { status: 403 });
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const url = new URL(request.url);
    const attachment: SocketAttachment = {
      credentials: {
        capabilityToken: url.searchParams.get("cap") ?? undefined,
        guestName: url.searchParams.get("guest") ?? undefined,
        sessionToken: parseCookies(request.headers.get("Cookie"))["jot_session"],
      },
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
        socket.serializeAttachment({ ...attachment, initialized: true });
        return;
      }

      if (message.type === "body-update") {
        const connection = yield* application.connectCollaboration(
          attachment.credentials,
          attachment.documentId,
        );
        const update = yield* decodeBase64(message.update);
        const accepted = yield* connection.acceptUpdate(update, message.clientUpdateId);
        yield* this.#broadcast(attachment.documentId, accepted);
        yield* Effect.tryPromise({
          catch: (cause) => cause,
          try: () => this.#state.storage.setAlarm(Date.now() + 2_000),
        });
        return;
      }

      if (message.type === "presence") {
        yield* this.#broadcast(
          attachment.documentId,
          { presence: message.presence, type: "presence" },
          socket,
        );
      }
    });
  }

  #broadcast(
    documentId: string,
    message: ServerCollaborationMessage,
    excluded?: WebSocket,
  ): Effect.Effect<void, unknown> {
    return Effect.forEach(
      this.#state.getWebSockets(documentId).filter((socket) => socket !== excluded),
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
      Effect.forEach(
        this.#state.getWebSockets(),
        (socket) =>
          send(socket, { reason: "document_changed", type: "resynchronize" }).pipe(
            Effect.catchAll(() => Effect.void),
          ),
        { concurrency: "unbounded", discard: true },
      ),
    );
  }
}

const worker: ExportedHandler<CloudflareEnvironment> = {
  fetch(request, environment) {
    const url = new URL(request.url);
    if (isApplicationPath(url.pathname)) {
      const workspace = environment.JOT_WORKSPACE.get(
        environment.JOT_WORKSPACE.idFromName("primary"),
      );
      return workspace.fetch(request);
    }
    return environment.ASSETS.fetch(request);
  },
};

export default worker;

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

function parseCookies(header: string | null): Readonly<Record<string, string>> {
  if (header === null) return {};
  return Object.fromEntries(
    header.split(";").flatMap((part) => {
      const separator = part.indexOf("=");
      if (separator === -1) return [];
      const key = part.slice(0, separator).trim();
      const value = part.slice(separator + 1).trim();
      return [[key, value]];
    }),
  );
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
  return pathname === "/api" || pathname.startsWith("/api/") || pathname.startsWith("/rfc/");
}
