import { Effect, Either, type ManagedRuntime, type Schema } from "effect";
import { Hono } from "hono";
import type { Context as HonoContext } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";

import {
  ApiKeyCreateRequestSchema,
  CreateDocumentRequestSchema,
  CreateThreadRequestSchema,
  decodeUnknown,
  EditBodyRequestSchema,
  EditMessageRequestSchema,
  ImportDocumentRequestSchema,
  MetadataPatchRequestSchema,
  PasswordRequestSchema,
  protocolVersion,
  ReplaceBodyRequestSchema,
  ReplyRequestSchema,
  ResolutionRequestSchema,
  ShareUpdateRequestSchema,
} from "@earendil-works/jot-protocol";
import type { CatalogResponse, HealthResponse, ProtocolError } from "@earendil-works/jot-protocol";

import { ApplicationError, JotApplication } from "./application.ts";
import type { JotApplicationService, RequestCredentials, SessionResult } from "./application.ts";

export type {
  AttachmentContent,
  BackupVerification,
  CollaborationConnection,
  JotApplicationService,
  RequestCredentials,
  SessionResult,
} from "./application.ts";
export { ApplicationError, JotApplication } from "./application.ts";
export { localApplicationLayer, makeLocalJotApplication } from "./local.ts";
export type { LocalApplicationOptions } from "./local.ts";
export { DigestLive, IdGeneratorLive, SecretHasherLive, SecureTokenLive } from "./crypto.ts";

export interface BackendOptions {
  readonly version?: string | undefined;
  readonly runtime?: ManagedRuntime.ManagedRuntime<JotApplicationService, never> | undefined;
}

export function createBackendApp(options: BackendOptions = {}): Hono {
  const app = new Hono();
  const version = options.version ?? "development";

  app.use("*", async (context, next) => {
    await next();
    context.header("Referrer-Policy", "strict-origin-when-cross-origin");
    context.header("X-Content-Type-Options", "nosniff");
    context.header("X-Frame-Options", "DENY");
    if (context.req.path.startsWith("/api/") && context.res.headers.get("Cache-Control") === null) {
      context.header("Cache-Control", "no-store");
    }
  });

  app.get("/api/health", (context) => {
    const response: HealthResponse = {
      protocolVersion,
      service: "jot",
      status: "ok",
      version,
    };
    context.header("Cache-Control", "no-store");
    return context.json(response);
  });

  app.get("/api/auth/status", (context) =>
    execute(context, options, (service) => service.authenticationStatus(credentials(context))),
  );

  app.post("/api/auth/setup", (context) =>
    execute(
      context,
      options,
      (service) =>
        readJson(context, PasswordRequestSchema).pipe(
          Effect.flatMap(({ password }) => service.setupOwner(password)),
        ),
      (result) => setSession(context, result),
    ),
  );

  app.post("/api/auth/login", (context) =>
    execute(
      context,
      options,
      (service) =>
        readJson(context, PasswordRequestSchema).pipe(
          Effect.flatMap(({ password }) => service.login(password)),
        ),
      (result) => setSession(context, result),
    ),
  );

  app.post("/api/auth/logout", (context) =>
    execute(context, options, (service) =>
      requireMutationProtection(context).pipe(
        Effect.zipRight(service.logout(credentials(context))),
        Effect.tap(() =>
          Effect.sync(() => {
            deleteCookie(context, "jot_session", { path: "/" });
            deleteCookie(context, "jot_csrf", { path: "/" });
          }),
        ),
      ),
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
      ({ bytes, metadata }) => {
        context.header("Cache-Control", "private, max-age=3600");
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
        Effect.zipRight(service.publish(credentials(context), context.req.param("documentId"))),
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
    execute(context, options, (service) =>
      service.listPublicDocuments(
        context.req.query("q") ?? "",
        context.req.query("state"),
        context.req.query("label"),
      ),
    ),
  );

  app.get("/api/public/rfc/:number", (context) =>
    execute(context, options, (service) =>
      positiveInteger(context.req.param("number"), "RFC number").pipe(
        Effect.flatMap((number) => service.readPublicRfc(number)),
      ),
    ),
  );

  app.get("/rfc/:number", (context) =>
    execute(
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
        return context.html(publicCatalogHtml(`Keyword: ${context.req.param("label")}`, catalog));
      },
    ),
  );

  app.get("/rfc/:number/:slug", (context) => {
    const number = Number(context.req.param("number"));
    return Number.isSafeInteger(number)
      ? context.redirect(`/rfc/${String(number).padStart(4, "0")}`, 308)
      : context.notFound();
  });

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
        context.header("Content-Disposition", 'attachment; filename="jot-backup.json"');
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
      message: "The requested Jot resource does not exist.",
      retryable: false,
    };
    return context.json(response, 404);
  });

  return app;
}

const inlineAttachmentTypes = new Set(["image/gif", "image/jpeg", "image/png", "image/webp"]);

function execute<A>(
  context: HonoContext,
  options: BackendOptions,
  operation: (service: JotApplicationService) => Effect.Effect<A, ApplicationError>,
  respond: (value: A) => Response | Promise<Response> = (value) => context.json(value),
): Promise<Response> {
  if (options.runtime === undefined) {
    return Promise.resolve(
      context.json(
        {
          code: "service_unavailable",
          message: "The Jot application runtime is not configured.",
          retryable: true,
        } satisfies ProtocolError,
        503,
      ),
    );
  }
  return options.runtime
    .runPromise(Effect.flatMap(JotApplication, operation).pipe(Effect.either))
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
  const filename = context.req.header("X-Jot-Filename");
  const mediaType = context.req.header("Content-Type");
  if (filename === undefined || mediaType === undefined) {
    return Effect.fail(
      new ApplicationError({
        code: "invalid_attachment",
        message: "Attachment uploads require Content-Type and X-Jot-Filename headers.",
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
    guestName: context.req.header("X-Jot-Guest-Name"),
    sessionToken: getCookie(context, "jot_session"),
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
  const csrfCookie = getCookie(context, "jot_csrf");
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

function setSession(context: HonoContext, result: SessionResult): Response {
  const secure = new URL(context.req.url).protocol === "https:";
  setCookie(context, "jot_session", result.sessionToken, {
    expires: new Date(result.expiresAt),
    httpOnly: true,
    path: "/",
    sameSite: "Strict",
    secure,
  });
  setCookie(context, "jot_csrf", result.csrfToken, {
    expires: new Date(result.expiresAt),
    httpOnly: false,
    path: "/",
    sameSite: "Strict",
    secure,
  });
  context.header("Cache-Control", "no-store");
  return context.json({ expiresAt: result.expiresAt });
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
          ? `/documents/${encodeURIComponent(metadata.id)}`
          : `/rfc/${String(metadata.rfcNumber).padStart(4, "0")}`;
      const labels = metadata.labels
        .map((label) => `<a href="/keyword/${encodeURIComponent(label)}">${escapeHtml(label)}</a>`)
        .join(" ");
      return `<li><a class="title" href="${href}">${metadata.rfcNumber === undefined ? "Document" : `RFC ${String(metadata.rfcNumber).padStart(4, "0")}`} — ${escapeHtml(metadata.title)}</a><p>${escapeHtml(excerpt)}</p><small><a href="/state/${encodeURIComponent(metadata.lifecycleState)}">${escapeHtml(metadata.lifecycleState)}</a> · ${escapeHtml(metadata.updatedAt.slice(0, 10))} ${labels}</small></li>`;
    })
    .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="description" content="Published Jot documents"><title>${title} — Jot</title><style>${publicStyles}${publicCatalogStyles}</style></head><body><header><a href="/">JOT</a><span>PUBLIC CATALOG</span></header><main><article><h1>${title}</h1><ol class="catalog">${rows || "<li>No published documents.</li>"}</ol></article></main></body></html>`;
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
  readonly metadata: { readonly rfcNumber?: number | undefined; readonly title: string };
}): string {
  const title = escapeHtml(document.metadata.title);
  const description = escapeHtml(document.description);
  const toc = document.headings
    .map(
      (heading) =>
        `<li class="depth-${heading.depth}"><a href="#${escapeHtml(heading.id)}">${escapeHtml(heading.text)}</a></li>`,
    )
    .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="description" content="${description}"><meta property="og:title" content="${title}"><meta property="og:description" content="${description}"><link rel="canonical" href="${escapeHtml(document.canonicalPath)}"><title>${title} — Jot</title><style>${publicStyles}</style></head><body><header><a href="/">JOT</a><span>RFC ${String(document.metadata.rfcNumber ?? "—").padStart(4, "0")}</span></header><main><aside><p>Contents</p><ol>${toc}</ol></aside><article>${document.html}</article></main></body></html>`;
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
  "default-src 'none'; img-src 'self' https: data:; style-src 'unsafe-inline'; script-src 'self'; connect-src 'self'; font-src 'self'; base-uri 'none'; frame-ancestors 'none'";

const publicCatalogStyles = `.catalog{list-style:none;padding:0}.catalog li{padding:1.5rem 0;border-bottom:1px solid #888}.catalog .title{font-size:1.25rem;font-weight:700}.catalog p{margin:.4rem 0}.catalog small{font-family:ui-monospace,monospace}`;

const publicStyles = `:root{color-scheme:light dark;font-family:ui-serif,Georgia,serif;line-height:1.65}body{margin:0}header{display:flex;justify-content:space-between;padding:1rem 3vw;border-bottom:1px solid #888;font:700 .75rem ui-monospace,monospace;letter-spacing:.08em}main{display:grid;grid-template-columns:minmax(12rem,18rem) minmax(0,48rem);gap:clamp(2rem,6vw,7rem);max-width:78rem;margin:0 auto;padding:clamp(3rem,8vw,8rem) 3vw}aside{font: .8rem ui-monospace,monospace}aside ol{padding-left:1.2rem}.depth-3{margin-left:1rem}article{min-width:0}article h1{font-size:clamp(2.8rem,7vw,5.5rem);line-height:.95}pre{overflow:auto;padding:1rem;background:#171916;color:#f4efe5}table{border-collapse:collapse}td,th{border:1px solid #888;padding:.4rem .7rem}img{max-width:100%}@media(max-width:50rem){main{grid-template-columns:1fr}aside{display:none}}`;
