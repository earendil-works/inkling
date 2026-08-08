import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import { Effect, Fiber, Stream, type ManagedRuntime } from "effect";
import { WebSocket, WebSocketServer } from "ws";
import type { RawData } from "ws";

import { ApplicationError, InklingApplication } from "@earendil-works/inkling-backend";
import type {
  CollaborationConnection,
  InklingApplicationService,
  RequestCredentials,
} from "@earendil-works/inkling-backend";
import {
  ClientCollaborationMessageSchema,
  decodeJson,
  encodeJson,
  ServerCollaborationMessageSchema,
} from "@earendil-works/inkling-protocol";
import type {
  ClientCollaborationMessage,
  PresenceDto,
  ServerCollaborationMessage,
} from "@earendil-works/inkling-protocol";
import { decodeBase64 } from "@earendil-works/inkling-collaboration";
import type { ServerType } from "@hono/node-server";

interface ConnectedClient {
  readonly documentId: string;
  presence?: PresenceDto | undefined;
  readonly socket: WebSocket;
  readonly updateTimes: number[];
}

export function installWebSocketServer(
  server: ServerType,
  runtime: ManagedRuntime.ManagedRuntime<InklingApplicationService, never>,
): () => void {
  const webSocketServer = new WebSocketServer({ maxPayload: 1_200_000, noServer: true });
  const clients = new Set<ConnectedClient>();

  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const host = request.headers.host;
    if (host === undefined || request.url === undefined || !isAllowedOrigin(request, host)) {
      socket.destroy();
      return;
    }
    const url = new URL(request.url, `http://${host}`);
    const match = /^\/api\/documents\/([^/]+)\/ws$/u.exec(url.pathname);
    if (match?.[1] === undefined) {
      socket.destroy();
      return;
    }
    const documentId = safeDecodeURIComponent(match[1]);
    if (documentId === undefined) {
      socket.destroy();
      return;
    }
    const requestCredentials: RequestCredentials = {
      capabilityToken: url.searchParams.get("cap") ?? undefined,
      guestName: url.searchParams.get("guest") ?? undefined,
      sessionToken: parseCookies(request.headers.cookie)["inkling_session"],
    };

    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      webSocketServer.emit("connection", webSocket, request, documentId, requestCredentials);
    });
  };

  server.on("upgrade", onUpgrade);
  webSocketServer.on(
    "connection",
    (
      socket: WebSocket,
      _request: IncomingMessage,
      documentId: string,
      credentials: RequestCredentials,
    ) => {
      let connection: CollaborationConnection | undefined;
      let eventsFiber: Fiber.RuntimeFiber<void, never> | undefined;
      let initialized = false;
      const client: ConnectedClient = { documentId, socket, updateTimes: [] };
      if ([...clients].filter((other) => other.documentId === documentId).length >= 64) {
        socket.close(4029, "participant_limit");
        return;
      }
      clients.add(client);

      const fail = (error: unknown): Effect.Effect<void> => {
        const applicationError =
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
          error: {
            code: applicationError.code,
            message: applicationError.message,
            retryable: applicationError.retryable,
          },
          type: "error",
        }).pipe(
          Effect.ignore,
          Effect.ensuring(Effect.sync(() => socket.close(4000, applicationError.code))),
        );
      };

      const processMessage = (
        data: RawData,
      ): Effect.Effect<void, unknown, InklingApplicationService> =>
        decodeMessage(data).pipe(
          Effect.flatMap((message) =>
            Effect.gen(function* () {
              if (!initialized) {
                if (message.type !== "hello") {
                  return yield* Effect.fail(
                    new ApplicationError({
                      code: "protocol_required",
                      message: "The first collaboration message must negotiate the protocol.",
                      retryable: false,
                      status: 400,
                    }),
                  );
                }
                const stateVector =
                  message.stateVector === undefined
                    ? undefined
                    : yield* decodeBase64(message.stateVector);
                const service = yield* InklingApplication;
                const established = yield* service.connectCollaboration(
                  credentials,
                  documentId,
                  stateVector,
                );
                connection = established;
                initialized = true;
                yield* send(socket, established.welcome);
                const existingPresences = [...clients].flatMap((other) =>
                  other !== client &&
                  other.documentId === documentId &&
                  other.presence !== undefined
                    ? [other.presence]
                    : [],
                );
                yield* Effect.forEach(
                  existingPresences,
                  (presence) => send(socket, { presence, type: "presence" }),
                  { discard: true },
                );
                eventsFiber = yield* Stream.runForEach(established.events, (event) =>
                  send(socket, event).pipe(
                    Effect.tap(() =>
                      event.type === "permission-changed" && !event.actions.includes("read-working")
                        ? Effect.sync(() => socket.close(4003, "access_revoked"))
                        : Effect.void,
                    ),
                    Effect.catchAll(() => Effect.void),
                  ),
                ).pipe(Effect.forkDaemon);
                return;
              }

              const currentConnection = connection;
              if (currentConnection === undefined) {
                return yield* Effect.fail(
                  new ApplicationError({
                    code: "connection_missing",
                    message: "The collaboration session is not initialized.",
                    retryable: true,
                    status: 503,
                  }),
                );
              }
              if (message.type === "body-update") {
                const threshold = Date.now() - 10_000;
                const firstRecent = client.updateTimes.findIndex(
                  (acceptedAt) => acceptedAt >= threshold,
                );
                client.updateTimes.splice(
                  0,
                  firstRecent === -1 ? client.updateTimes.length : firstRecent,
                );
                if (client.updateTimes.length >= 200) {
                  return yield* Effect.fail(
                    new ApplicationError({
                      code: "update_rate_limit",
                      message: "The collaboration update rate limit was exceeded.",
                      retryable: true,
                      status: 429,
                    }),
                  );
                }
                client.updateTimes.push(Date.now());
                const update = yield* decodeBase64(message.update);
                yield* currentConnection.acceptUpdate(update, message.clientUpdateId);
                return;
              }
              if (message.type === "presence") {
                client.presence = message.presence;
                const wire: ServerCollaborationMessage = {
                  presence: message.presence,
                  type: "presence",
                };
                yield* Effect.forEach(
                  [...clients].filter(
                    (other) => other !== client && other.documentId === documentId,
                  ),
                  (other) => send(other.socket, wire).pipe(Effect.ignore),
                  { concurrency: "unbounded", discard: true },
                );
              }
            }),
          ),
        );

      let disconnected = false;
      const disconnect = (): void => {
        if (disconnected) return;
        disconnected = true;
        clients.delete(client);
        const participantId = client.presence?.participantId;
        client.presence = undefined;
        if (participantId !== undefined) {
          runtime.runFork(
            Effect.forEach(
              [...clients].filter((other) => other.documentId === documentId),
              (other) =>
                send(other.socket, { participantId, type: "presence-left" }).pipe(Effect.ignore),
              { concurrency: "unbounded", discard: true },
            ),
          );
        }
        if (eventsFiber !== undefined) {
          runtime.runFork(Fiber.interrupt(eventsFiber));
        }
      };

      socket.on("message", (data) => {
        runtime.runFork(processMessage(data).pipe(Effect.catchAll(fail)));
      });
      socket.on("close", disconnect);
      socket.on("error", disconnect);
    },
  );

  return () => {
    server.off("upgrade", onUpgrade);
    for (const client of clients) {
      client.socket.close(1001, "server_shutdown");
    }
    webSocketServer.close();
  };
}

function decodeMessage(data: RawData): Effect.Effect<ClientCollaborationMessage, unknown> {
  const text = typeof data === "string" ? data : data.toString();
  return decodeJson(ClientCollaborationMessageSchema, text);
}

function send(
  socket: WebSocket,
  message: ServerCollaborationMessage,
): Effect.Effect<void, unknown> {
  if (socket.readyState !== WebSocket.OPEN) {
    return Effect.void;
  }
  return encodeJson(ServerCollaborationMessageSchema, message).pipe(
    Effect.flatMap((text) =>
      Effect.try({
        catch: (error) => error,
        try: () => socket.send(text),
      }),
    ),
  );
}

function safeDecodeURIComponent(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

function isAllowedOrigin(request: IncomingMessage, host: string): boolean {
  const origin = request.headers.origin;
  if (origin === undefined) {
    return false;
  }
  try {
    const originUrl = new URL(origin);
    return (
      (originUrl.protocol === "http:" || originUrl.protocol === "https:") && originUrl.host === host
    );
  } catch {
    return false;
  }
}

function parseCookies(header: string | undefined): Readonly<Record<string, string>> {
  if (header === undefined) {
    return {};
  }
  return Object.fromEntries(
    header.split(";").flatMap((part) => {
      const separator = part.indexOf("=");
      if (separator === -1) {
        return [];
      }
      const key = part.slice(0, separator).trim();
      const value = part.slice(separator + 1).trim();
      try {
        return [[key, decodeURIComponent(value)]];
      } catch {
        return [];
      }
    }),
  );
}
