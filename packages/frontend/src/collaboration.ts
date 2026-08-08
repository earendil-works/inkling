import { Data, Effect } from "effect";
import * as Y from "yjs";

import { identifierTag, taggedId, uuidV7Bytes } from "@earendil-works/inkling-core";

import { browserRuntime } from "./effect-runtime.ts";

import {
  ClientCollaborationMessageSchema,
  decodeJson,
  encodeJson,
  ServerCollaborationMessageSchema,
} from "@earendil-works/inkling-protocol";
import type {
  CommentStateDto,
  DocumentMetadataDto,
  PresenceDto,
  ServerCollaborationMessage,
} from "@earendil-works/inkling-protocol";
import {
  decodeBase64,
  encodeBase64,
  encodeStateVector,
} from "@earendil-works/inkling-collaboration";

const remoteOrigin = Symbol("inkling-remote-update");

export type ConnectionState = "connecting" | "disconnected" | "ready" | "saving";

export interface CollaborationCallbacks {
  readonly onComments: (comments: CommentStateDto) => void;
  readonly onMetadata: (metadata: DocumentMetadataDto) => void;
  readonly onPermissions: (actions: readonly string[]) => void;
  readonly onPresence: (presence: PresenceDto) => void;
  readonly onPresenceLeft: (participantId: string) => void;
  readonly onRevision: (revision: number) => void;
  readonly onState: (state: ConnectionState) => void;
  readonly onError: (message: string) => void;
}

export interface CollaborationClient {
  readonly close: Effect.Effect<void>;
  /** Waits until every local update has been durably accepted by the document authority. */
  readonly flush: Effect.Effect<void, CollaborationClientError>;
  readonly sendPresence: (presence: PresenceDto) => Effect.Effect<void>;
}

export class CollaborationClientError extends Data.TaggedError("CollaborationClientError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export function makeCollaborationClient(
  documentId: string,
  document: Y.Doc,
  capabilityToken: string | undefined,
  guestName: string | undefined,
  callbacks: CollaborationCallbacks,
): Effect.Effect<CollaborationClient, CollaborationClientError> {
  return Effect.sync(() => {
    let socket: WebSocket | undefined;
    let reconnectTimer: number | undefined;
    let stopped = false;
    let welcomed = false;
    const unacknowledged = new Map<string, Uint8Array>();
    const flushWaiters = new Set<{
      readonly fail: (error: CollaborationClientError) => void;
      readonly succeed: () => void;
    }>();

    const settleFlushWaiters = (): void => {
      if (!welcomed || unacknowledged.size !== 0) return;
      for (const waiter of flushWaiters) waiter.succeed();
    };

    const failFlushWaiters = (message: string): void => {
      const error = new CollaborationClientError({ message });
      for (const waiter of flushWaiters) waiter.fail(error);
    };

    const flush = Effect.async<void, CollaborationClientError>((resume) => {
      if (stopped) {
        resume(
          Effect.fail(
            new CollaborationClientError({ message: "The editor connection is closed." }),
          ),
        );
        return;
      }
      if (welcomed && unacknowledged.size === 0) {
        resume(Effect.void);
        return;
      }
      let settled = false;
      let timeout: number | undefined;
      const finish = (effect: Effect.Effect<void, CollaborationClientError>): void => {
        if (settled) return;
        settled = true;
        if (timeout !== undefined) window.clearTimeout(timeout);
        flushWaiters.delete(waiter);
        resume(effect);
      };
      const waiter = {
        fail: (error: CollaborationClientError) => finish(Effect.fail(error)),
        succeed: () => finish(Effect.void),
      };
      flushWaiters.add(waiter);
      timeout = window.setTimeout(
        () =>
          waiter.fail(
            new CollaborationClientError({
              message: "Inkling could not save the document before publishing.",
            }),
          ),
        30_000,
      );
      return Effect.sync(() => {
        settled = true;
        if (timeout !== undefined) window.clearTimeout(timeout);
        flushWaiters.delete(waiter);
      });
    });

    const sendMessage = (message: typeof ClientCollaborationMessageSchema.Type): void => {
      const current = socket;
      if (current === undefined || current.readyState !== WebSocket.OPEN) {
        return;
      }
      browserRuntime.runFork(
        encodeJson(ClientCollaborationMessageSchema, message).pipe(
          Effect.tap((payload) =>
            Effect.sync(() => {
              current.send(payload);
            }),
          ),
          Effect.catchAll((error) => Effect.sync(() => callbacks.onError(String(error)))),
        ),
      );
    };

    const handleServerMessage = (
      message: ServerCollaborationMessage,
    ): Effect.Effect<void, CollaborationClientError> =>
      Effect.gen(function* () {
        switch (message.type) {
          case "welcome": {
            const update = yield* decodeBase64(message.stateUpdate).pipe(
              Effect.mapError(
                (cause) =>
                  new CollaborationClientError({ cause, message: "The server state is invalid." }),
              ),
            );
            yield* Effect.sync(() => {
              Y.applyUpdate(document, update, remoteOrigin);
              callbacks.onComments(message.comments);
              callbacks.onMetadata(message.metadata);
              callbacks.onPermissions(message.actions);
              welcomed = true;
              for (const [clientUpdateId, pending] of unacknowledged) {
                sendMessage({
                  clientUpdateId,
                  type: "body-update",
                  update: encodeBase64(pending),
                });
              }
              callbacks.onState(unacknowledged.size === 0 ? "ready" : "saving");
              settleFlushWaiters();
            });
            break;
          }
          case "update-accepted": {
            if (message.update !== undefined) {
              const update = yield* decodeBase64(message.update).pipe(
                Effect.mapError(
                  (cause) =>
                    new CollaborationClientError({
                      cause,
                      message: "A remote update is invalid.",
                    }),
                ),
              );
              yield* Effect.sync(() => Y.applyUpdate(document, update, remoteOrigin));
            }
            yield* Effect.sync(() => {
              unacknowledged.delete(message.clientUpdateId);
              callbacks.onRevision(message.documentRevision);
              callbacks.onState(unacknowledged.size === 0 ? "ready" : "saving");
              settleFlushWaiters();
            });
            break;
          }
          case "comments-changed":
            yield* Effect.sync(() => callbacks.onComments(message.comments));
            break;
          case "metadata-changed":
            yield* Effect.sync(() => callbacks.onMetadata(message.metadata));
            break;
          case "permission-changed":
            yield* Effect.sync(() => callbacks.onPermissions(message.actions));
            break;
          case "presence":
            yield* Effect.sync(() => callbacks.onPresence(message.presence));
            break;
          case "presence-left":
            yield* Effect.sync(() => callbacks.onPresenceLeft(message.participantId));
            break;
          case "resynchronize":
            yield* Effect.sync(() => socket?.close(4010, "resynchronize"));
            break;
          case "error":
            yield* Effect.sync(() => callbacks.onError(message.error.message));
            break;
        }
      });

    const connect = (): void => {
      if (stopped) {
        return;
      }
      callbacks.onState("connecting");
      const url = new URL(`/api/documents/${encodeURIComponent(documentId)}/ws`, location.href);
      url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
      if (capabilityToken !== undefined) {
        url.searchParams.set("cap", capabilityToken);
      }
      if (guestName !== undefined) {
        url.searchParams.set("guest", guestName);
      }
      socket = new WebSocket(url);
      welcomed = false;

      socket.addEventListener("open", () => {
        browserRuntime.runFork(
          encodeStateVector(document).pipe(
            Effect.tap((stateVector) =>
              Effect.sync(() =>
                sendMessage({
                  protocolVersion: 1,
                  stateVector: encodeBase64(stateVector),
                  type: "hello",
                }),
              ),
            ),
          ),
        );
      });
      socket.addEventListener("message", (event) => {
        if (typeof event.data !== "string") {
          callbacks.onError("Inkling received an unsupported binary message.");
          return;
        }
        browserRuntime.runFork(
          decodeJson(ServerCollaborationMessageSchema, event.data).pipe(
            Effect.flatMap(handleServerMessage),
            Effect.catchAll((error) => Effect.sync(() => callbacks.onError(String(error)))),
          ),
        );
      });
      socket.addEventListener("close", () => {
        if (stopped) {
          return;
        }
        callbacks.onState("disconnected");
        reconnectTimer = window.setTimeout(connect, 1_500);
      });
      socket.addEventListener("error", () => {
        if (!welcomed) {
          callbacks.onState("disconnected");
        }
      });
    };

    const updateHandler = (update: Uint8Array, origin: unknown): void => {
      if (origin === remoteOrigin) {
        return;
      }
      const clientUpdateId = taggedId(
        identifierTag.clientUpdate,
        uuidV7Bytes(Date.now(), crypto.getRandomValues(new Uint8Array(10))),
      );
      unacknowledged.set(clientUpdateId, update);
      callbacks.onState(socket?.readyState === WebSocket.OPEN ? "saving" : "disconnected");
      sendMessage({ clientUpdateId, type: "body-update", update: encodeBase64(update) });
    };
    document.on("update", updateHandler);
    connect();

    return {
      close: Effect.sync(() => {
        stopped = true;
        failFlushWaiters("The editor connection closed before the document was saved.");
        if (reconnectTimer !== undefined) {
          window.clearTimeout(reconnectTimer);
        }
        document.off("update", updateHandler);
        socket?.close(1000, "editor_closed");
      }),
      flush,
      sendPresence: (presence) => Effect.sync(() => sendMessage({ presence, type: "presence" })),
    };
  });
}
