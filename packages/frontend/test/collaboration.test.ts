import assert from "node:assert/strict";
import test from "node:test";

import { Effect } from "effect";
import * as Y from "yjs";

import { decodeBase64, encodeBase64 } from "@earendil-works/inkling-collaboration";

import { makeCollaborationClient } from "../src/collaboration.ts";
import type { ConnectionState } from "../src/collaboration.ts";

interface FakeSocketEvent {
  readonly data?: unknown;
}

type FakeSocketListener = (event: FakeSocketEvent) => void;

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;

  readonly sent: string[] = [];
  readyState = FakeWebSocket.CONNECTING;
  readonly #listeners = new Map<string, Set<FakeSocketListener>>();

  addEventListener(type: string, listener: FakeSocketListener): void {
    const listeners = this.#listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(type, listeners);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.#emit("close", {});
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.#emit("open", {});
  }

  receive(data: string): void {
    this.#emit("message", { data });
  }

  send(data: unknown): void {
    this.sent.push(String(data));
  }

  #emit(type: string, event: FakeSocketEvent): void {
    for (const listener of this.#listeners.get(type) ?? []) listener(event);
  }
}

test("edits made before the collaboration welcome remain pending until acknowledged", async () => {
  const originalWebSocket = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const originalLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
  const sockets: FakeWebSocket[] = [];
  class TestWebSocket extends FakeWebSocket {
    constructor() {
      super();
      sockets.push(this);
    }
  }

  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    value: TestWebSocket,
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
      setTimeout: globalThis.setTimeout.bind(globalThis),
    },
  });
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: new URL("http://inkling.example/documents/document_test/edit"),
  });

  const localDocument = new Y.Doc();
  const serverDocument = new Y.Doc();
  serverDocument.getText("body").insert(0, "# Server title\n");
  const states: ConnectionState[] = [];

  try {
    const client = await Effect.runPromise(
      makeCollaborationClient("document_test", localDocument, undefined, undefined, {
        onComments: () => undefined,
        onError: (message) => assert.fail(message),
        onMetadata: () => undefined,
        onPermissions: () => undefined,
        onPresence: () => undefined,
        onPresenceLeft: () => undefined,
        onRevision: () => undefined,
        onState: (state) => states.push(state),
      }),
    );
    const socket = sockets[0];
    assert.ok(socket);

    localDocument.getText("body").insert(0, "typed before welcome");
    socket.open();
    await waitFor(() => socket.sent.some((payload) => JSON.parse(payload).type === "hello"));

    socket.receive(
      JSON.stringify({
        actions: ["edit-body", "read-working"],
        comments: { revision: 0, threads: [] },
        metadata: {
          approvers: [],
          authors: [],
          createdAt: "2026-01-01T00:00:00.000Z",
          headRevision: 0,
          id: "document_test",
          labels: [],
          lifecycleState: "draft",
          relatedDocuments: [],
          reviewers: [],
          sensitivity: "normal",
          sharing: { access: "disabled", generation: 0 },
          title: "Server title",
          updatedAt: "2026-01-01T00:00:00.000Z",
          visibility: "workspace",
        },
        protocolVersion: 1,
        sequence: 0,
        stateUpdate: encodeBase64(Y.encodeStateAsUpdate(serverDocument)),
        type: "welcome",
      }),
    );

    await waitFor(() => states.at(-1) === "saving");
    const updateMessage = await waitForValue(() =>
      socket.sent
        .map((payload) => JSON.parse(payload) as Readonly<Record<string, unknown>>)
        .find((message) => message["type"] === "body-update"),
    );
    assert.equal(states.at(-1), "saving");

    let flushed = false;
    const flush = Effect.runPromise(client.flush).then(() => {
      flushed = true;
      return undefined;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(flushed, false);

    const encodedUpdate = updateMessage["update"];
    const clientUpdateId = updateMessage["clientUpdateId"];
    assert.equal(typeof encodedUpdate, "string");
    assert.equal(typeof clientUpdateId, "string");
    Y.applyUpdate(serverDocument, await Effect.runPromise(decodeBase64(encodedUpdate)));
    assert.match(serverDocument.getText("body").toString(), /typed before welcome/u);

    socket.receive(
      JSON.stringify({
        clientUpdateId,
        documentRevision: 1,
        serverSequence: 1,
        type: "update-accepted",
      }),
    );
    await flush;
    assert.equal(states.at(-1), "ready");
    await Effect.runPromise(client.close);
  } finally {
    localDocument.destroy();
    serverDocument.destroy();
    restoreGlobal("WebSocket", originalWebSocket);
    restoreGlobal("window", originalWindow);
    restoreGlobal("location", originalLocation);
  }
});

async function waitFor(predicate: () => boolean, timeout = 2_000): Promise<void> {
  return waitUntil(predicate, Date.now() + timeout);
}

async function waitUntil(predicate: () => boolean, deadline: number): Promise<void> {
  if (predicate()) return;
  if (Date.now() >= deadline) throw new Error("Timed out waiting for collaboration state.");
  await new Promise((resolve) => setTimeout(resolve, 5));
  return waitUntil(predicate, deadline);
}

async function waitForValue<A>(read: () => A | undefined, timeout = 2_000): Promise<A> {
  let value = read();
  await waitFor(() => {
    value = read();
    return value !== undefined;
  }, timeout);
  return value as A;
}

function restoreGlobal(name: string, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor === undefined) {
    Reflect.deleteProperty(globalThis, name);
  } else {
    Object.defineProperty(globalThis, name, descriptor);
  }
}
