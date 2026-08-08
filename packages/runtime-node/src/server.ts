import path from "node:path";
import { fileURLToPath } from "node:url";

import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { NodeFileSystem } from "@effect/platform-node";
import { Effect, Layer, ManagedRuntime, type Scope } from "effect";

import { createBackendApp } from "@earendil-works/inkling-backend";
import type {
  GoogleAuthenticationEnvironment,
  InklingApplicationService,
} from "@earendil-works/inkling-backend";
import { MarkdownRendererLive } from "@earendil-works/inkling-renderer";

import { localApplicationLayer } from "./application.ts";
import { DigestLive, IdGeneratorLive, SecretHasherLive, SecureTokenLive } from "./crypto.ts";
import { acquireDataDirectoryLock, DataDirectoryLockError } from "./lock.ts";
import { journalLayer, objectStoreLayer, workspaceStateStoreLayer } from "./storage.ts";
import { installWebSocketServer } from "./websocket.ts";

export interface StartServerOptions {
  readonly port: number;
  readonly dataDirectory: string;
  readonly version?: string | undefined;
  readonly googleAuthentication?: GoogleAuthenticationEnvironment | undefined;
  readonly onListen?: ((port: number) => void) | undefined;
}

export interface RunningServer {
  readonly server: ServerType;
  readonly runtime: ManagedRuntime.ManagedRuntime<InklingApplicationService, never>;
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
  return path.resolve(rawValue ?? path.join(process.cwd(), ".inkling"));
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
          message: "The Inkling application runtime could not initialize.",
        }),
      try: () => runtime.runtime(),
    });

    const app = createBackendApp({
      googleAuthentication: options.googleAuthentication ?? googleAuthenticationFromEnvironment(),
      runtime,
      version: options.version,
    });
    const frontendRoot = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../frontend/dist",
    );
    app.get("/documents/*", serveStatic({ path: "index.html", root: frontendRoot }));
    app.get("/rfcs/*", serveStatic({ path: "index.html", root: frontendRoot }));
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

export function googleAuthenticationFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): GoogleAuthenticationEnvironment {
  return {
    GOOGLE_ADMIN_EMAILS: environment["GOOGLE_ADMIN_EMAILS"],
    GOOGLE_ALLOWED_DOMAIN: environment["GOOGLE_ALLOWED_DOMAIN"],
    GOOGLE_ALLOWED_DOMAINS: environment["GOOGLE_ALLOWED_DOMAINS"],
    GOOGLE_CLIENT_ID: environment["GOOGLE_CLIENT_ID"],
    GOOGLE_CLIENT_SECRET: environment["GOOGLE_CLIENT_SECRET"],
    GOOGLE_REDIRECT_URI: environment["GOOGLE_REDIRECT_URI"],
    INKLING_GOOGLE_AUTHORIZATION_ENDPOINT: environment["INKLING_GOOGLE_AUTHORIZATION_ENDPOINT"],
    INKLING_GOOGLE_CERTIFICATES_ENDPOINT: environment["INKLING_GOOGLE_CERTIFICATES_ENDPOINT"],
    INKLING_GOOGLE_DIRECTORY_ENDPOINT: environment["INKLING_GOOGLE_DIRECTORY_ENDPOINT"],
    INKLING_GOOGLE_TOKEN_ENDPOINT: environment["INKLING_GOOGLE_TOKEN_ENDPOINT"],
    INKLING_OAUTH_STATE_SECRET: environment["INKLING_OAUTH_STATE_SECRET"],
  };
}

function createRuntime(
  dataDirectory: string,
): ManagedRuntime.ManagedRuntime<InklingApplicationService, never> {
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
  const dependencies = Layer.mergeAll(base, storage, IdGeneratorLive);
  const application = localApplicationLayer().pipe(Layer.provide(dependencies), Layer.orDie);
  return ManagedRuntime.make(application);
}
