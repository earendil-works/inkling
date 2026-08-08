import { Effect, Either, type ManagedRuntime, type Schema } from "effect";
import { Hono } from "hono";
import type { Context as HonoContext } from "hono";
import { deleteCookie, getCookie } from "hono/cookie";

import {
  ApiKeyCreateRequestSchema,
  CreateDocumentRequestSchema,
  CreateThreadRequestSchema,
  decodeUnknown,
  EditBodyRequestSchema,
  EditMessageRequestSchema,
  ImportDocumentRequestSchema,
  MetadataPatchRequestSchema,
  protocolVersion,
  ReplaceBodyRequestSchema,
  ReplyRequestSchema,
  ResolutionRequestSchema,
  ShareUpdateRequestSchema,
} from "@earendil-works/inkling-protocol";
import { taggedId, uuidV7Bytes } from "@earendil-works/inkling-core";
import type {
  CatalogResponse,
  DocumentMetadataDto,
  HealthResponse,
  ProtocolError,
} from "@earendil-works/inkling-protocol";

import { ApplicationError, InklingApplication } from "./application.ts";
import type { InklingApplicationService, RequestCredentials } from "./application.ts";
import { finishGoogleAuthentication, startGoogleAuthentication } from "./google-auth.ts";
import type { GoogleAuthenticationEnvironment } from "./google-auth.ts";

export type {
  ApplicationDiagnostics,
  AttachmentContent,
  BackupVerification,
  CollaborationConnection,
  DocumentRuntimeConfiguration,
  InklingApplicationService,
  RequestCredentials,
  SessionResult,
} from "./application.ts";
export { ApplicationError, InklingApplication } from "./application.ts";
export { localApplicationLayer, makeLocalInklingApplication } from "./local.ts";
export type { LocalApplicationOptions } from "./local.ts";
export { DigestLive, IdGeneratorLive, SecretHasherLive, SecureTokenLive } from "./crypto.ts";
export {
  finishGoogleAuthentication,
  isGoogleEmailAllowed,
  parseAllowedGoogleDomains,
  startGoogleAuthentication,
} from "./google-auth.ts";
export type { GoogleAuthenticationEnvironment, GoogleIdentityLogin } from "./google-auth.ts";

export interface BackendOptions {
  readonly googleAuthentication?: GoogleAuthenticationEnvironment | undefined;
  readonly version?: string | undefined;
  readonly runtime?: ManagedRuntime.ManagedRuntime<InklingApplicationService, never> | undefined;
}

export function createBackendApp(options: BackendOptions = {}): Hono {
  const app = new Hono();
  const version = options.version ?? "development";

  app.use("*", async (context, next) => {
    const startedAt = Date.now();
    const requestId = taggedId(
      "request",
      uuidV7Bytes(startedAt, crypto.getRandomValues(new Uint8Array(10))),
    );
    await next();
    context.header("X-Request-Id", requestId);
    console.log(
      JSON.stringify({
        durationMs: Date.now() - startedAt,
        method: context.req.method,
        operation: operationCategory(context.req.path),
        requestId,
        result: context.res.status < 400 ? "success" : "failure",
        status: context.res.status,
      }),
    );
    context.header("Referrer-Policy", "strict-origin-when-cross-origin");
    context.header("X-Content-Type-Options", "nosniff");
    context.header("X-Frame-Options", "DENY");
    if (context.req.path.startsWith("/api/") && context.res.headers.get("Cache-Control") === null) {
      context.header("Cache-Control", "no-store");
    }
  });

  app.get("/AGENTS.md", (context) => {
    context.header("Cache-Control", "public, max-age=300");
    context.header("Content-Type", "text/markdown; charset=UTF-8");
    return context.body(agentInstructions(new URL(context.req.url).origin));
  });

  app.get("/api/health", (context) => {
    const response: HealthResponse = {
      protocolVersion,
      service: "inkling",
      status: "ok",
      version,
    };
    context.header("Cache-Control", "no-store");
    return context.json(response);
  });

  app.get("/api/auth/status", (context) =>
    execute(context, options, (service) => service.authenticationStatus(credentials(context))),
  );

  app.get("/api/auth/google/start", (context) =>
    startGoogleAuthentication(context.req.raw, options.googleAuthentication ?? {}),
  );

  app.get("/api/auth/google/callback", async (context) => {
    const runtime = options.runtime;
    if (runtime === undefined) {
      return context.json(
        {
          code: "service_unavailable",
          message: "The Inkling application runtime is not configured.",
          retryable: true,
        } satisfies ProtocolError,
        503,
      );
    }
    return finishGoogleAuthentication(
      context.req.raw,
      options.googleAuthentication ?? {},
      (identity, people) =>
        runtime.runPromise(
          Effect.flatMap(InklingApplication, (service) =>
            service.loginWorkspaceIdentity(identity, people),
          ),
        ),
    );
  });

  app.post("/api/auth/logout", (context) =>
    execute(
      context,
      options,
      (service) =>
        requireMutationProtection(context).pipe(
          Effect.zipRight(service.logout(credentials(context))),
          Effect.tap(() =>
            Effect.sync(() => {
              deleteCookie(context, "inkling_session", { path: "/" });
              deleteCookie(context, "inkling_csrf", { path: "/" });
            }),
          ),
        ),
      () => context.json({}),
    ),
  );

  app.get("/api/documents", (context) =>
    execute(context, options, (service) =>
      service.listDocuments(credentials(context), context.req.query("q") ?? ""),
    ),
  );

  app.post("/api/documents", (context) =>
    execute(context, options, (service) =>
      mutation(context, readJson(context, CreateDocumentRequestSchema)).pipe(
        Effect.flatMap((request) => service.createDocument(credentials(context), request)),
      ),
    ),
  );

  app.get("/api/documents/:documentId", (context) =>
    execute(context, options, (service) => {
      const start = optionalPositiveInteger(context.req.query("startLine"));
      const end = optionalPositiveInteger(context.req.query("endLine"));
      return Effect.all({ end, start }).pipe(
        Effect.flatMap((range) =>
          service.readDocument(
            credentials(context),
            context.req.param("documentId"),
            range.start,
            range.end,
            context.req.query("published") === "true",
          ),
        ),
      );
    }),
  );

  app.get("/api/documents/:documentId/attachments", (context) =>
    execute(context, options, (service) =>
      service
        .listAttachments(credentials(context), context.req.param("documentId"))
        .pipe(Effect.map((attachments) => ({ attachments }))),
    ),
  );

  app.post("/api/documents/:documentId/attachments", (context) =>
    execute(context, options, (service) =>
      mutation(context, readAttachmentUpload(context)).pipe(
        Effect.flatMap((upload) =>
          service.uploadAttachment(
            credentials(context),
            context.req.param("documentId"),
            upload.filename,
            upload.mediaType,
            upload.bytes,
          ),
        ),
      ),
    ),
  );

  app.get("/api/documents/:documentId/attachments/:attachmentId", (context) =>
    execute(
      context,
      options,
      (service) =>
        service.readAttachment(
          credentials(context),
          context.req.param("documentId"),
          context.req.param("attachmentId"),
        ),
      ({ bytes, metadata, publicCache }) => {
        context.header(
          "Cache-Control",
          publicCache ? "public, max-age=31536000, immutable" : "private, max-age=3600",
        );
        context.header("Content-Type", metadata.mediaType);
        context.header("ETag", `"${metadata.digest}"`);
        context.header(
          "Content-Disposition",
          `${inlineAttachmentTypes.has(metadata.mediaType) ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(metadata.filename)}`,
        );
        context.header("X-Content-Type-Options", "nosniff");
        return context.body(new Uint8Array(bytes).buffer);
      },
    ),
  );

  app.patch("/api/documents/:documentId/metadata", (context) =>
    execute(context, options, (service) =>
      mutation(context, readJson(context, MetadataPatchRequestSchema)).pipe(
        Effect.flatMap((request) =>
          service.updateMetadata(credentials(context), context.req.param("documentId"), request),
        ),
      ),
    ),
  );

  app.post("/api/documents/:documentId/rfc", (context) =>
    execute(context, options, (service) =>
      mutation(
        context,
        service
          .reserveRfcNumber(credentials(context), context.req.param("documentId"))
          .pipe(
            Effect.flatMap((rfcNumber) =>
              service.assignRfcNumber(
                credentials(context),
                context.req.param("documentId"),
                rfcNumber,
              ),
            ),
          ),
      ),
    ),
  );

  app.post("/api/documents/:documentId/edits", (context) =>
    execute(context, options, (service) =>
      mutation(context, readJson(context, EditBodyRequestSchema)).pipe(
        Effect.flatMap((request) =>
          service.editBody(credentials(context), context.req.param("documentId"), request),
        ),
      ),
    ),
  );

  app.put("/api/documents/:documentId/body", (context) =>
    execute(context, options, (service) =>
      mutation(context, readJson(context, ReplaceBodyRequestSchema)).pipe(
        Effect.flatMap((request) =>
          service.replaceBody(credentials(context), context.req.param("documentId"), request),
        ),
      ),
    ),
  );

  app.delete("/api/documents/:documentId", (context) =>
    execute(context, options, (service) =>
      mutation(context, requiredRevision(context)).pipe(
        Effect.flatMap((expectedRevision) =>
          service.deleteDocument(
            credentials(context),
            context.req.param("documentId"),
            expectedRevision,
          ),
        ),
      ),
    ),
  );

  app.patch("/api/documents/:documentId/share", (context) =>
    execute(context, options, (service) =>
      mutation(context, readJson(context, ShareUpdateRequestSchema)).pipe(
        Effect.flatMap((request) =>
          service.updateShare(
            credentials(context),
            context.req.param("documentId"),
            request,
            new URL(context.req.url).origin,
          ),
        ),
      ),
    ),
  );

  app.post("/api/documents/:documentId/comments", (context) =>
    execute(context, options, (service) =>
      mutation(context, readJson(context, CreateThreadRequestSchema)).pipe(
        Effect.flatMap((request) =>
          service.createThread(credentials(context), context.req.param("documentId"), request),
        ),
      ),
    ),
  );

  app.post("/api/documents/:documentId/comments/:threadId/replies", (context) =>
    execute(context, options, (service) =>
      mutation(context, readJson(context, ReplyRequestSchema)).pipe(
        Effect.flatMap((request) =>
          service.reply(
            credentials(context),
            context.req.param("documentId"),
            context.req.param("threadId"),
            request,
          ),
        ),
      ),
    ),
  );

  app.patch("/api/documents/:documentId/comments/:threadId/messages/:messageId", (context) =>
    execute(context, options, (service) =>
      mutation(context, readJson(context, EditMessageRequestSchema)).pipe(
        Effect.flatMap((request) =>
          service.editMessage(
            credentials(context),
            context.req.param("documentId"),
            context.req.param("threadId"),
            context.req.param("messageId"),
            request,
          ),
        ),
      ),
    ),
  );

  app.delete("/api/documents/:documentId/comments/:threadId/messages/:messageId", (context) =>
    execute(context, options, (service) =>
      mutation(context, Effect.void).pipe(
        Effect.zipRight(
          service.deleteMessage(
            credentials(context),
            context.req.param("documentId"),
            context.req.param("threadId"),
            context.req.param("messageId"),
          ),
        ),
      ),
    ),
  );

  app.patch("/api/documents/:documentId/comments/:threadId/resolution", (context) =>
    execute(context, options, (service) =>
      mutation(context, readJson(context, ResolutionRequestSchema)).pipe(
        Effect.flatMap((request) =>
          service.resolveThread(
            credentials(context),
            context.req.param("documentId"),
            context.req.param("threadId"),
            request,
          ),
        ),
      ),
    ),
  );

  app.delete("/api/documents/:documentId/comments/:threadId", (context) =>
    execute(context, options, (service) =>
      mutation(context, Effect.void).pipe(
        Effect.zipRight(
          service.deleteThread(
            credentials(context),
            context.req.param("documentId"),
            context.req.param("threadId"),
          ),
        ),
      ),
    ),
  );

  app.post("/api/documents/:documentId/publish", (context) =>
    execute(context, options, (service) =>
      mutation(context, Effect.void).pipe(
        Effect.zipRight(
          service.publish(
            credentials(context),
            context.req.param("documentId"),
            context.req.query("confirmConfidentialPublic") === "true",
          ),
        ),
      ),
    ),
  );

  app.post("/api/documents/:documentId/unpublish", (context) =>
    execute(context, options, (service) =>
      mutation(context, Effect.void).pipe(
        Effect.zipRight(service.unpublish(credentials(context), context.req.param("documentId"))),
      ),
    ),
  );

  app.get("/api/public/documents", (context) =>
    execute(
      context,
      options,
      (service) =>
        service.listPublicDocuments(
          context.req.query("q") ?? "",
          context.req.query("state"),
          context.req.query("label"),
        ),
      (catalog) => {
        context.header(
          "Cache-Control",
          "public, max-age=0, s-maxage=60, stale-while-revalidate=300",
        );
        return context.json(catalog);
      },
    ),
  );

  app.get("/api/public/documents/:documentId", (context) =>
    execute(context, options, (service) =>
      service.readPublicDocument(context.req.param("documentId")),
    ),
  );

  app.get("/public/documents/:documentId", (context) =>
    execute(
      context,
      options,
      (service) => service.readPublicDocument(context.req.param("documentId")),
      (document) => {
        context.header("Cache-Control", "public, max-age=300, stale-while-revalidate=3600");
        context.header("Content-Security-Policy", contentSecurityPolicy);
        return context.html(publicDocumentHtml(document));
      },
    ),
  );

  app.get("/api/public/rfc/:number", (context) =>
    execute(context, options, (service) =>
      positiveInteger(context.req.param("number"), "RFC number").pipe(
        Effect.flatMap((number) => service.readPublicRfc(number)),
      ),
    ),
  );

  app.get("/rfcs/:number", (context, next) =>
    getCookie(context, "inkling_session") !== undefined
      ? next()
      : execute(
          context,
          options,
          (service) =>
            positiveInteger(context.req.param("number"), "RFC number").pipe(
              Effect.flatMap((number) => service.readPublicRfc(number)),
            ),
          (document) => {
            context.header("Cache-Control", "public, max-age=300, stale-while-revalidate=3600");
            context.header("Content-Security-Policy", contentSecurityPolicy);
            return context.html(publicDocumentHtml(document));
          },
        ),
  );

  app.get("/state/:state", (context) =>
    execute(
      context,
      options,
      (service) => service.listPublicDocuments("", context.req.param("state")),
      (catalog) => {
        context.header("Cache-Control", "public, max-age=300, stale-while-revalidate=3600");
        context.header("Content-Security-Policy", contentSecurityPolicy);
        return context.html(publicCatalogHtml(`State: ${context.req.param("state")}`, catalog));
      },
    ),
  );

  app.get("/keyword/:label", (context) =>
    execute(
      context,
      options,
      (service) => service.listPublicDocuments("", undefined, context.req.param("label")),
      (catalog) => {
        context.header("Cache-Control", "public, max-age=300, stale-while-revalidate=3600");
        context.header("Content-Security-Policy", contentSecurityPolicy);
        return context.html(publicCatalogHtml(`Label: ${context.req.param("label")}`, catalog));
      },
    ),
  );

  app.get("/rfcs/:number/:slug", (context, next) => {
    if (context.req.param("slug") === "edit") return next();
    const number = Number(context.req.param("number"));
    return Number.isSafeInteger(number)
      ? context.redirect(`/rfcs/${String(number).padStart(4, "0")}`, 308)
      : context.notFound();
  });

  app.get("/rfc/:number", redirectLegacyRfc);
  app.get("/rfc/:number/:slug", redirectLegacyRfc);

  app.post("/api/admin/import", (context) =>
    execute(context, options, (service) =>
      mutation(context, readJson(context, ImportDocumentRequestSchema)).pipe(
        Effect.flatMap((request) => service.importDocument(credentials(context), request)),
      ),
    ),
  );

  app.get("/api/admin/backup", (context) =>
    execute(
      context,
      options,
      (service) => service.exportWorkspace(credentials(context)),
      (bytes) => {
        context.header("Cache-Control", "no-store");
        context.header("Content-Disposition", 'attachment; filename="inkling-backup.json"');
        context.header("Content-Type", "application/json; charset=utf-8");
        return context.body(new Uint8Array(bytes).buffer);
      },
    ),
  );

  app.post("/api/admin/restore", (context) =>
    execute(context, options, (service) =>
      mutation(context, readBinaryBody(context, 250_000_000)).pipe(
        Effect.flatMap((archive) => service.restoreWorkspace(credentials(context), archive)),
      ),
    ),
  );

  app.get("/api/admin/verify", (context) =>
    execute(context, options, (service) => service.verifyWorkspace(credentials(context))),
  );

  app.get("/api/admin/diagnostics", (context) =>
    execute(context, options, (service) => service.diagnostics(credentials(context))),
  );

  app.post("/api/admin/repair", (context) =>
    execute(context, options, (service) =>
      mutation(context, service.repairCatalog(credentials(context))),
    ),
  );

  app.post("/api/api-keys", (context) =>
    execute(context, options, (service) =>
      mutation(context, readJson(context, ApiKeyCreateRequestSchema)).pipe(
        Effect.flatMap(({ label }) => service.createApiKey(credentials(context), label)),
      ),
    ),
  );

  app.get("/api/api-keys", (context) =>
    execute(context, options, (service) => service.listApiKeys(credentials(context))),
  );

  app.delete("/api/api-keys/:keyId", (context) =>
    execute(context, options, (service) =>
      mutation(context, Effect.void).pipe(
        Effect.zipRight(service.revokeApiKey(credentials(context), context.req.param("keyId"))),
      ),
    ),
  );

  app.notFound((context) => {
    const response: ProtocolError = {
      code: "not_found",
      message: "The requested Inkling resource does not exist.",
      retryable: false,
    };
    return context.json(response, 404);
  });

  return app;
}

const inlineAttachmentTypes = new Set(["image/gif", "image/jpeg", "image/png", "image/webp"]);

function agentInstructions(baseUrl: string): string {
  return `# Inkling agent instructions

This server is an Inkling workspace for collaborative Markdown notes and RFCs.
Its base URL is ${baseUrl}.

Use the \`inkling\` command-line client for workspace operations. Do not scrape the browser UI or call private storage directly.

## Connect your CLI

First check whether a workspace is already configured:

\`\`\`sh
inkling instance list
inkling --help
\`\`\`

If this server is not configured, ask the user to connect it:

1. Open ${baseUrl} and sign in.
2. Open the account menu in the top-right corner and choose **API keys**.
3. Create a personal key and copy it when it is revealed. The secret is shown only once.
4. In the agent's terminal, substitute the copied key for \`API_KEY\` and run:

\`\`\`sh
inkling instance add workspace ${baseUrl} API_KEY
inkling use workspace
\`\`\`

Do not paste the key into source files, chat transcripts, AGENTS.md, or skills. The command stores it in Inkling's user-only CLI configuration. API keys belong to the user who created them and have that user's workspace permissions. If a key is lost, revoke it and create another one.

Select the instance when necessary:

\`\`\`sh
inkling use workspace
# Alternatively, set INKLING_INSTANCE for one command.
INKLING_INSTANCE=workspace inkling list
\`\`\`

If \`inkling\` is not on \`PATH\`, ask the user how the Inkling CLI is installed in their environment. In an Inkling source checkout it can be run as \`node packages/cli/src/main.ts\`.

## Safe command-line workflow

Run \`inkling --help\` for the complete, current command list. Common operations include:

\`\`\`sh
inkling list
inkling search 'state:discussion label:platform'
inkling read DOCUMENT_ID
inkling read DOCUMENT_ID --lines 1:120
inkling create 'Proposal title' --rfc
inkling edit DOCUMENT_ID 'unique old text' 'replacement text'
inkling comment DOCUMENT_ID START_OFFSET END_OFFSET 'Review comment'
inkling publish DOCUMENT_ID
\`\`\`

Follow these rules:

- Read a document before changing it. Use line ranges for large documents.
- Prefer \`inkling edit\`, which replaces unique existing text and rejects missing or ambiguous matches. Re-read and retry after a concurrent revision conflict.
- Use \`inkling replace\` only when the user explicitly wants a full-body replacement.
- Preserve the frontmatter and top-level title conventions shown in the document.
- Use thread and message IDs printed by \`inkling read\` for replies and comment management.
- Never print, commit, log, or embed API keys or capability URLs.

## Create a reusable agent skill

If the user asks for reusable Inkling support, create an [Agent Skills](https://agentskills.io/) skill rather than editing a project's AGENTS.md. Prefer \`~/.agents/skills/inkling/SKILL.md\` for a user-wide skill or \`.agents/skills/inkling/SKILL.md\` when the user requests a project-local skill. Use this minimal shape:

\`\`\`markdown
---
name: inkling
description: Work with Inkling Markdown workspaces through the inkling CLI. Use when reading, searching, editing, commenting on, or publishing Inkling notes and RFCs.
---

# Inkling

- Run \`inkling --help\` for the current CLI contract.
- Run \`inkling instance list\` before work and select the intended instance.
- Read before editing; use unique-text edits and re-read after conflicts.
- Keep credentials only in Inkling's CLI config, never in this skill.
- Workspace agent instructions: ${baseUrl}/AGENTS.md
\`\`\`

The skill may record the non-secret base URL and preferred instance name, but it must never contain an API key. Keep detailed command documentation here at ${baseUrl}/AGENTS.md so the skill does not become stale.
`;
}

function redirectLegacyRfc(context: HonoContext): Response | Promise<Response> {
  const number = Number(context.req.param("number"));
  return Number.isSafeInteger(number)
    ? context.redirect(`/rfcs/${String(number).padStart(4, "0")}`, 308)
    : context.notFound();
}

function operationCategory(pathname: string): string {
  if (pathname.includes("/attachments")) return "attachment";
  if (pathname.includes("/comments")) return "comment";
  if (pathname.includes("/publish")) return "publication";
  if (pathname.includes("/auth/")) return "authentication";
  if (pathname.includes("/admin/")) return "administration";
  if (pathname.includes("/documents")) return "document";
  if (pathname.includes("/rfc/") || pathname.includes("/rfcs/")) return "public-rfc";
  return "http";
}

function execute<A>(
  context: HonoContext,
  options: BackendOptions,
  operation: (service: InklingApplicationService) => Effect.Effect<A, ApplicationError>,
  respond: (value: A) => Response | Promise<Response> = (value) => context.json(value),
): Promise<Response> {
  if (options.runtime === undefined) {
    return Promise.resolve(
      context.json(
        {
          code: "service_unavailable",
          message: "The Inkling application runtime is not configured.",
          retryable: true,
        } satisfies ProtocolError,
        503,
      ),
    );
  }
  return options.runtime
    .runPromise(Effect.flatMap(InklingApplication, operation).pipe(Effect.either))
    .then((result) =>
      Either.isRight(result) ? respond(result.right) : errorResponse(context, result.left),
    );
}

function readJson<A, I>(
  context: HonoContext,
  schema: Schema.Schema<A, I>,
): Effect.Effect<A, ApplicationError> {
  return Effect.tryPromise({
    catch: (cause) =>
      new ApplicationError({
        cause,
        code: "invalid_json",
        message: "The request body must be valid JSON.",
        retryable: false,
        status: 400,
      }),
    try: () => context.req.json() as Promise<unknown>,
  }).pipe(
    Effect.flatMap((input) => decodeUnknown(schema, input)),
    Effect.mapError((error) =>
      error instanceof ApplicationError
        ? error
        : new ApplicationError({
            cause: error,
            code: "invalid_request",
            message: "The request does not match the expected schema.",
            retryable: false,
            status: 400,
          }),
    ),
  );
}

function readBinaryBody(
  context: HonoContext,
  maximumBytes: number,
): Effect.Effect<Uint8Array, ApplicationError> {
  const contentLength = Number(context.req.header("Content-Length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
    return Effect.fail(
      new ApplicationError({
        code: "request_too_large",
        message: `The request body may not exceed ${maximumBytes} bytes.`,
        retryable: false,
        status: 413,
      }),
    );
  }
  return Effect.tryPromise({
    catch: (cause) =>
      new ApplicationError({
        cause,
        code: "invalid_body",
        message: "The request body could not be read.",
        retryable: false,
        status: 400,
      }),
    try: () => context.req.arrayBuffer(),
  }).pipe(
    Effect.flatMap((buffer) =>
      buffer.byteLength <= maximumBytes
        ? Effect.succeed(new Uint8Array(buffer))
        : Effect.fail(
            new ApplicationError({
              code: "request_too_large",
              message: `The request body may not exceed ${maximumBytes} bytes.`,
              retryable: false,
              status: 413,
            }),
          ),
    ),
  );
}

function readAttachmentUpload(
  context: HonoContext,
): Effect.Effect<
  { readonly bytes: Uint8Array; readonly filename: string; readonly mediaType: string },
  ApplicationError
> {
  const filename = context.req.header("X-Inkling-Filename");
  const mediaType = context.req.header("Content-Type");
  if (filename === undefined || mediaType === undefined) {
    return Effect.fail(
      new ApplicationError({
        code: "invalid_attachment",
        message: "Attachment uploads require Content-Type and X-Inkling-Filename headers.",
        retryable: false,
        status: 400,
      }),
    );
  }
  const contentLength = Number(context.req.header("Content-Length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > 10_000_000) {
    return Effect.fail(
      new ApplicationError({
        code: "attachment_size",
        message: "Attachments may not exceed 10 MB.",
        retryable: false,
        status: 413,
      }),
    );
  }
  return Effect.tryPromise({
    catch: (cause) =>
      new ApplicationError({
        cause,
        code: "invalid_attachment",
        message: "The attachment body could not be read.",
        retryable: false,
        status: 400,
      }),
    try: () => context.req.arrayBuffer(),
  }).pipe(Effect.map((buffer) => ({ bytes: new Uint8Array(buffer), filename, mediaType })));
}

function credentials(context: HonoContext): RequestCredentials {
  const authorization = context.req.header("Authorization");
  const bearerToken = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : undefined;
  return {
    bearerToken,
    capabilityToken: context.req.query("cap"),
    guestName: context.req.header("X-Inkling-Guest-Name"),
    sessionToken: getCookie(context, "inkling_session"),
  };
}

function mutation<A>(
  context: HonoContext,
  effect: Effect.Effect<A, ApplicationError>,
): Effect.Effect<A, ApplicationError> {
  return requireMutationProtection(context).pipe(Effect.zipRight(effect));
}

function requireMutationProtection(context: HonoContext): Effect.Effect<void, ApplicationError> {
  const requestCredentials = credentials(context);
  if (
    requestCredentials.sessionToken === undefined ||
    requestCredentials.bearerToken !== undefined
  ) {
    return Effect.void;
  }
  const origin = context.req.header("Origin");
  const csrfHeader = context.req.header("X-CSRF-Token");
  const csrfCookie = getCookie(context, "inkling_csrf");
  const expectedOrigin = new URL(context.req.url).origin;
  return origin === expectedOrigin && csrfHeader !== undefined && csrfHeader === csrfCookie
    ? Effect.void
    : Effect.fail(
        new ApplicationError({
          code: "csrf_rejected",
          message: "The mutation failed origin or CSRF validation.",
          retryable: false,
          status: 403,
        }),
      );
}

function errorResponse(context: HonoContext, error: ApplicationError): Response {
  const response: ProtocolError = {
    code: error.code,
    currentRevision: error.currentRevision,
    message: error.message,
    retryable: error.retryable,
  };
  context.header("Cache-Control", "no-store");
  return context.json(response, error.status);
}

function optionalPositiveInteger(
  value: string | undefined,
): Effect.Effect<number | undefined, ApplicationError> {
  return value === undefined
    ? Effect.succeed(undefined)
    : positiveInteger(value, "line number").pipe(Effect.map((number) => number));
}

function positiveInteger(value: string, label: string): Effect.Effect<number, ApplicationError> {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0
    ? Effect.succeed(number)
    : Effect.fail(
        new ApplicationError({
          code: "invalid_number",
          message: `The ${label} must be a positive integer.`,
          retryable: false,
          status: 400,
        }),
      );
}

function requiredRevision(context: HonoContext): Effect.Effect<number, ApplicationError> {
  const value = context.req.query("expectedRevision");
  return value === undefined
    ? Effect.fail(
        new ApplicationError({
          code: "missing_revision",
          message: "An expectedRevision query parameter is required.",
          retryable: false,
          status: 400,
        }),
      )
    : positiveIntegerOrZero(value, "expected revision");
}

function positiveIntegerOrZero(
  value: string,
  label: string,
): Effect.Effect<number, ApplicationError> {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0
    ? Effect.succeed(number)
    : Effect.fail(
        new ApplicationError({
          code: "invalid_number",
          message: `The ${label} must be a non-negative integer.`,
          retryable: false,
          status: 400,
        }),
      );
}

function publicCatalogHtml(titleValue: string, catalog: CatalogResponse): string {
  const title = escapeHtml(titleValue);
  const rows = catalog.documents
    .map(({ excerpt, metadata }) => {
      const href =
        metadata.rfcNumber === undefined
          ? `/public/documents/${encodeURIComponent(metadata.id)}`
          : `/rfcs/${String(metadata.rfcNumber).padStart(4, "0")}`;
      const labels = metadata.labels
        .map((label) => `<a href="/keyword/${encodeURIComponent(label)}">${escapeHtml(label)}</a>`)
        .join(" ");
      const state = publicStateLink(metadata.lifecycleState, "public-catalog-state");
      return `<li><a class="title" href="${href}">${metadata.rfcNumber === undefined ? "Note" : `RFC ${String(metadata.rfcNumber).padStart(4, "0")}`} — ${escapeHtml(metadata.title)}</a><p>${escapeHtml(excerpt)}</p><small>${state} · ${escapeHtml(metadata.updatedAt.slice(0, 10))} ${labels}</small></li>`;
    })
    .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="description" content="Published notes and RFCs"><title>Inkling</title><link rel="stylesheet" href="/fonts.css"><link rel="stylesheet" href="/public.css"></head><body><header class="public-masthead"><a href="/">INKLING</a><span>PUBLISHED</span></header><main class="public-catalog-shell"><article class="public-paper public-catalog-paper"><h1>${title}</h1><ol class="catalog">${rows || "<li>No published notes or RFCs.</li>"}</ol></article></main></body></html>`;
}

function publicDocumentHtml(document: {
  readonly canonicalPath: string;
  readonly description: string;
  readonly headings: readonly {
    readonly depth: number;
    readonly id: string;
    readonly text: string;
  }[];
  readonly html: string;
  readonly metadata: DocumentMetadataDto;
}): string {
  const { metadata } = document;
  const title = escapeHtml(metadata.title);
  const description = escapeHtml(document.description);
  const folio =
    metadata.rfcNumber === undefined
      ? "Note"
      : `RFC ${String(metadata.rfcNumber).padStart(4, "0")}`;
  const toc = document.headings
    .map(
      (heading) =>
        `<li class="depth-${heading.depth}"><a href="#${escapeHtml(heading.id)}">${escapeHtml(heading.text)}</a></li>`,
    )
    .join("");
  const labels = metadata.labels
    .map((label) => `<a href="/keyword/${encodeURIComponent(label)}">${escapeHtml(label)}</a>`)
    .join("");
  const tocHtml =
    toc === ""
      ? ""
      : `<aside class="public-toc" aria-label="On this page"><p>On this page</p><ol>${toc}</ol></aside>`;
  const state = publicStateLink(metadata.lifecycleState);
  const classification = publicClassificationChip(metadata);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="description" content="${description}"><meta property="og:title" content="${title}"><meta property="og:description" content="${description}"><link rel="canonical" href="${escapeHtml(document.canonicalPath)}"><title>${title}</title><link rel="stylesheet" href="/fonts.css"><link rel="stylesheet" href="/public.css"></head><body><header class="public-masthead"><a href="/">INKLING</a><span>${folio}</span></header><main class="public-page-shell"><article class="public-paper public-document"><div class="public-topline"><a href="/">Inkling</a></div><header class="public-hero"><p class="public-folio">${folio}</p><div class="public-hero-main"><div class="public-hero-badges">${state}${classification}</div><h1>${title}</h1>${labels === "" ? "" : `<div class="public-labels" aria-label="Labels">${labels}</div>`}</div></header>${publicMetadataHtml(metadata)}<div class="public-content-grid"><div class="public-prose">${document.html}</div>${tocHtml}</div></article></main></body></html>`;
}

function publicClassificationChip(metadata: DocumentMetadataDto): string {
  const classification =
    metadata.sensitivity === "confidential" ? "confidential" : metadata.visibility;
  return `<span class="public-classification" data-document-classification="${classification}">${classification}</span>`;
}

function publicStateLink(state: string, className?: string | undefined): string {
  const classes = ["public-state", className].filter(Boolean).join(" ");
  const tone = state.trim().toLocaleLowerCase("en");
  return `<a class="${classes}" data-lifecycle-state="${escapeHtml(tone)}" href="/state/${encodeURIComponent(state)}">${escapeHtml(state)}</a>`;
}

function publicMetadataHtml(metadata: DocumentMetadataDto): string {
  const rows: readonly [string, string][] = [
    [
      "Authors",
      metadata.authors.length === 0
        ? '<span class="public-metadata-empty">Not specified</span>'
        : publicPeopleHtml(metadata.authors),
    ],
    [
      "Created",
      `<time datetime="${escapeHtml(metadata.createdAt)}">${formatPublicDate(metadata.createdAt)}</time>`,
    ],
    [
      "Updated",
      `<time datetime="${escapeHtml(metadata.updatedAt)}">${formatPublicDate(metadata.updatedAt)}</time>`,
    ],
    ...(metadata.reviewers.length === 0
      ? []
      : [["Reviewers", publicPeopleHtml(metadata.reviewers)] as [string, string]]),
    ...(metadata.approvers.length === 0
      ? []
      : [["Approvers", publicPeopleHtml(metadata.approvers)] as [string, string]]),
    ...(metadata.targetDecisionDate === undefined
      ? []
      : [
          [
            "Target decision",
            `<time datetime="${escapeHtml(metadata.targetDecisionDate)}">${formatPublicDate(metadata.targetDecisionDate)}</time>`,
          ] as [string, string],
        ]),
  ];
  return `<dl class="public-metadata">${rows.map(([label, value]) => `<div><dt>${label}</dt><dd>${value}</dd></div>`).join("")}</dl>`;
}

function publicPeopleHtml(people: DocumentMetadataDto["authors"]): string {
  return people
    .map(
      (person) =>
        `<a href="mailto:${escapeHtml(person.email)}" title="${escapeHtml(person.email)}">${escapeHtml(person.displayName)}</a>`,
    )
    .join(", ");
}

function formatPublicDate(value: string): string {
  return new Intl.DateTimeFormat("en", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
    year: "numeric",
  }).format(new Date(value));
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const contentSecurityPolicy =
  "default-src 'none'; img-src 'self' https: data:; style-src 'self' https://fonts.googleapis.com; script-src 'self'; connect-src 'self'; font-src 'self' https://fonts.gstatic.com; base-uri 'none'; frame-ancestors 'none'";
