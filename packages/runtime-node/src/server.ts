import path from "node:path";
import { fileURLToPath } from "node:url";

import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { NodeFileSystem } from "@effect/platform-node";
import { Effect, Layer, ManagedRuntime, type Scope } from "effect";

import { createBackendApp } from "@earendil-works/jot-backend";
import type { JotApplicationService } from "@earendil-works/jot-backend";
import { MarkdownRendererLive } from "@earendil-works/jot-renderer";

import { localApplicationLayer } from "./application.ts";
import { DigestLive, IdGeneratorLive, SecretHasherLive, SecureTokenLive } from "./crypto.ts";
import { acquireDataDirectoryLock, DataDirectoryLockError } from "./lock.ts";
import { journalLayer, objectStoreLayer, workspaceStateStoreLayer } from "./storage.ts";
import { installWebSocketServer } from "./websocket.ts";

export interface StartServerOptions {
  readonly port: number;
  readonly dataDirectory: string;
  readonly version?: string | undefined;
  readonly onListen?: ((port: number) => void) | undefined;
}

export interface RunningServer {
  readonly server: ServerType;
  readonly runtime: ManagedRuntime.ManagedRuntime<JotApplicationService, never>;
}

export function parsePort(rawValue: string | undefined): number {
  if (rawValue === undefined) {
    return 8787;
  }
  const port = Number(rawValue);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid PORT value: ${rawValue}`);
  }
  return port;
}

export function resolveDataDirectory(rawValue: string | undefined): string {
  return path.resolve(rawValue ?? path.join(process.cwd(), ".jot"));
}

export function startServer(
  options: StartServerOptions,
): Effect.Effect<RunningServer, DataDirectoryLockError, Scope.Scope> {
  return Effect.gen(function* () {
    yield* acquireDataDirectoryLock(options.dataDirectory);
    const runtime = createRuntime(options.dataDirectory);
    yield* Effect.tryPromise({
      catch: (cause) =>
        new DataDirectoryLockError({
          cause,
          message: "The Jot application runtime could not initialize.",
        }),
      try: () => runtime.runtime(),
    });

    const app = createBackendApp({ runtime, version: options.version });
    const frontendRoot = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../frontend/dist",
    );
    app.get("/documents/*", serveStatic({ path: "index.html", root: frontendRoot }));
    app.get("/share/*", serveStatic({ path: "index.html", root: frontendRoot }));
    app.use("/*", serveStatic({ root: frontendRoot }));

    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        serve(
          {
            fetch: app.fetch,
            port: options.port,
          },
          (address) => options.onListen?.(address.port),
        ),
      ),
      (running) =>
        Effect.async<void>((resume) => {
          running.close(() => resume(Effect.void));
        }).pipe(Effect.zipRight(Effect.promise(() => runtime.dispose()))),
    );
    const removeWebSockets = installWebSocketServer(server, runtime);
    yield* Effect.addFinalizer(() => Effect.sync(removeWebSockets));
    return { runtime, server };
  }).pipe(Effect.provide(NodeFileSystem.layer));
}

function createRuntime(
  dataDirectory: string,
): ManagedRuntime.ManagedRuntime<JotApplicationService, never> {
  const base = Layer.mergeAll(
    NodeFileSystem.layer,
    DigestLive,
    SecureTokenLive,
    SecretHasherLive,
    MarkdownRendererLive,
  );
  const storage = Layer.mergeAll(
    objectStoreLayer(dataDirectory),
    journalLayer(dataDirectory),
    workspaceStateStoreLayer(dataDirectory),
  ).pipe(Layer.provide(base));
  const identifiers = IdGeneratorLive.pipe(Layer.provide(SecureTokenLive));
  const dependencies = Layer.mergeAll(base, storage, identifiers);
  const application = localApplicationLayer().pipe(Layer.provide(dependencies), Layer.orDie);
  return ManagedRuntime.make(application);
}
