import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { NodeFileSystem } from "@effect/platform-node";
import { Effect, Layer, ManagedRuntime, type Scope } from "effect";

import {
  createBackendApp,
  decodeThemeJson,
  findBundledTheme,
  isDefaultThemeSelection,
  InklingApplication,
  staticAssetCacheControl,
  ThemeError,
} from "@earendil-works/inkling-backend";
import type {
  GoogleAuthenticationEnvironment,
  InklingApplicationService,
  OpenAiCompatibleEmbedderOptions,
  ThemeConfiguration,
} from "@earendil-works/inkling-backend";
import type * as FrontendServer from "@earendil-works/inkling-frontend/server";
import { MarkdownRendererLive } from "@earendil-works/inkling-renderer";

import { localApplicationLayer } from "./application.ts";
import {
  DigestLive,
  IdGeneratorLive,
  SecretHasherLive,
  SecureTokenLive,
  TokenHasherLive,
} from "./crypto.ts";
import { acquireDataDirectoryLock, DataDirectoryLockError } from "./lock.ts";
import { embeddingsFromEnvironment, searchIndexLayer } from "./search.ts";
import { journalLayer, objectStoreLayer, workspaceStateStoreLayer } from "./storage.ts";
import { installWebSocketServer } from "./websocket.ts";

export interface StartServerOptions {
  readonly port: number;
  readonly dataDirectory: string;
  readonly version?: string | undefined;
  readonly googleAuthentication?: GoogleAuthenticationEnvironment | undefined;
  readonly onListen?: ((port: number) => void) | undefined;
  readonly theme?: string | undefined;
  /** Semantic search embeddings; defaults to the `INKLING_EMBEDDINGS_*` environment. */
  readonly embeddings?: OpenAiCompatibleEmbedderOptions | undefined;
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
): Effect.Effect<RunningServer, DataDirectoryLockError | ThemeError, Scope.Scope> {
  return Effect.gen(function* () {
    const theme = yield* loadTheme(options.theme);
    yield* acquireDataDirectoryLock(options.dataDirectory);
    const embeddings = options.embeddings ?? embeddingsFromEnvironment();
    const runtime = createRuntime(options.dataDirectory, embeddings);
    yield* Effect.tryPromise({
      catch: (cause) =>
        new DataDirectoryLockError({
          cause,
          message: "The Inkling application runtime could not initialize.",
        }),
      try: () => runtime.runtime(),
    });

    yield* Effect.gen(function* () {
      while (true) {
        yield* Effect.tryPromise({
          catch: (error) => error,
          try: () =>
            runtime.runPromise(
              Effect.flatMap(InklingApplication, (application) =>
                application.purgeExpiredDocuments(new Date().toISOString()),
              ),
            ),
        }).pipe(
          Effect.tapError((error) => Effect.logError("Inkling trash cleanup failed", error)),
          Effect.ignore,
        );
        yield* Effect.sleep("1 hour");
      }
    }).pipe(Effect.forkScoped);

    if (embeddings !== undefined) {
      yield* Effect.gen(function* () {
        while (true) {
          const pending = yield* Effect.tryPromise({
            catch: (error) => error,
            try: () =>
              runtime.runPromise(
                Effect.flatMap(InklingApplication, (application) =>
                  application.refreshSearchIndex(),
                ),
              ),
          }).pipe(
            Effect.tapError((error) => Effect.logError("Inkling search embedding failed", error)),
            Effect.orElseSucceed(() => 0),
          );
          yield* Effect.sleep(pending > 0 ? "2 seconds" : "10 seconds");
        }
      }).pipe(Effect.forkScoped);
    }

    const app = createBackendApp({
      googleAuthentication: options.googleAuthentication ?? googleAuthenticationFromEnvironment(),
      runtime,
      theme,
      version: options.version,
    });
    const frontendRoot = path.join(
      path.dirname(
        fileURLToPath(import.meta.resolve("@earendil-works/inkling-frontend/package.json")),
      ),
      "dist",
    );
    const renderer = yield* loadApplicationRenderer(path.join(frontendRoot, "index.html"));
    if (renderer !== undefined) {
      // Application pages render on the server, loading their data through
      // this application as the browser would.
      app.on(["GET", "HEAD"], "*", async (context, next) => {
        const page = renderer.render({
          fetch: (request) => Promise.resolve(app.fetch(request)),
          request: context.req.raw,
          template: renderer.template,
        });
        if (page === undefined) return next();
        return page;
      });
    }
    app.get("/trash", serveStatic({ path: "index.html", root: frontendRoot }));
    app.get("/wiki", serveStatic({ path: "index.html", root: frontendRoot }));
    app.get("/documents/*", serveStatic({ path: "index.html", root: frontendRoot }));
    app.get("/rfc/*", serveStatic({ path: "index.html", root: frontendRoot }));
    app.get("/share/*", serveStatic({ path: "index.html", root: frontendRoot }));
    app.use(
      "/*",
      serveStatic({
        onFound: (_path, context) => {
          const cacheControl = staticAssetCacheControl(context.req.path);
          if (cacheControl !== undefined) context.header("Cache-Control", cacheControl);
        },
        root: frontendRoot,
      }),
    );

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

interface ApplicationRenderer {
  readonly render: typeof FrontendServer.renderApplication;
  readonly template: string;
}

/**
 * Loads the frontend's server renderer and the shell it renders into. Without
 * a frontend build, application pages are served as the static shell.
 */
function loadApplicationRenderer(
  templatePath: string,
): Effect.Effect<ApplicationRenderer | undefined> {
  return Effect.promise(async () => {
    try {
      const [{ renderApplication }, template] = await Promise.all([
        import("@earendil-works/inkling-frontend/server"),
        readFile(templatePath, "utf8"),
      ]);
      return { render: renderApplication, template };
    } catch {
      return undefined;
    }
  });
}

/** Loads `INKLING_THEME`; the default selection keeps Elanor's own theme and yields no overrides. */
export function loadTheme(
  selection: string | undefined,
  workingDirectory = process.cwd(),
): Effect.Effect<ThemeConfiguration | undefined, ThemeError> {
  const value = selection?.trim() ?? "";
  if (isDefaultThemeSelection(value)) return Effect.succeed(undefined);
  const bundled = findBundledTheme(value);
  if (bundled !== undefined) return Effect.succeed(bundled);
  if (value?.startsWith("{")) return decodeThemeJson(value);
  const filename = path.resolve(workingDirectory, value);
  return Effect.tryPromise({
    catch: (cause) =>
      new ThemeError({ cause, message: `Theme file could not be read: ${filename}` }),
    try: () => readFile(filename, "utf8"),
  }).pipe(Effect.flatMap(decodeThemeJson));
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
  embeddings: OpenAiCompatibleEmbedderOptions | undefined,
): ManagedRuntime.ManagedRuntime<InklingApplicationService, never> {
  const base = Layer.mergeAll(
    NodeFileSystem.layer,
    DigestLive,
    SecureTokenLive,
    SecretHasherLive,
    TokenHasherLive,
    MarkdownRendererLive,
  );
  const storage = Layer.mergeAll(
    objectStoreLayer(dataDirectory),
    journalLayer(dataDirectory),
    workspaceStateStoreLayer(dataDirectory),
    searchIndexLayer(dataDirectory, { embeddings }),
  ).pipe(Layer.provide(base));
  const dependencies = Layer.mergeAll(base, storage, IdGeneratorLive);
  const application = localApplicationLayer().pipe(Layer.provide(dependencies), Layer.orDie);
  return ManagedRuntime.make(application);
}

export { embeddingsFromEnvironment, openSqliteSearchDatabase, searchIndexLayer } from "./search.ts";
export type { NodeSearchOptions, SqliteSearchDatabase } from "./search.ts";
