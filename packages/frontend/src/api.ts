import { Context, Data, Effect, Layer, Schema } from "effect";

import {
  ApiKeyCreatedSchema,
  ApiKeySchema,
  AttachmentMetadataSchema,
  AuthenticationStatusSchema,
  CatalogResponseSchema,
  CommentStateSchema,
  DocumentHistoryResponseSchema,
  DocumentMetadataSchema,
  DocumentResponseSchema,
  ProtocolErrorSchema,
  PublicDocumentResponseSchema,
  ReferenceResolutionsResponseSchema,
  ShareLinksResponseSchema,
  ShareUnlockResponseSchema,
} from "@earendil-works/inkling-protocol";
import type {
  ApiKeyCreated,
  ApiKeyDto,
  AttachmentMetadataDto,
  AuthenticationStatus,
  CatalogResponse,
  CommentAnchorDto,
  CommentStateDto,
  CreateDocumentRequest,
  DocumentHistoryResponse,
  DocumentMetadataDto,
  DocumentResponse,
  PublicDocumentResponse,
  ReferenceResolutionsResponse,
  ShareLinksResponse,
  ShareUnlockResponse,
} from "@earendil-works/inkling-protocol";

/** References per request, which keeps request URLs short. */
const referencesPerRequest = 50;

function chunks<A>(values: readonly A[], size: number): readonly (readonly A[])[] {
  const result: A[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

export class ApiError extends Data.TaggedError("ApiError")<{
  readonly code: string;
  readonly message: string;
  readonly status: number;
  readonly retryable: boolean;
  readonly cause?: unknown;
}> {}

export interface ApiClientService {
  readonly authenticationStatus: Effect.Effect<AuthenticationStatus, ApiError>;
  readonly createApiKey: (label: string) => Effect.Effect<ApiKeyCreated, ApiError>;
  readonly listApiKeys: Effect.Effect<readonly ApiKeyDto[], ApiError>;
  readonly revealApiKey: (keyId: string) => Effect.Effect<ApiKeyCreated, ApiError>;
  readonly revokeApiKey: (keyId: string) => Effect.Effect<void, ApiError>;
  readonly logout: Effect.Effect<void, ApiError>;
  readonly listDocuments: (query?: string) => Effect.Effect<CatalogResponse, ApiError>;
  readonly listDeletedDocuments: Effect.Effect<CatalogResponse, ApiError>;
  readonly listPublicDocuments: (query?: string) => Effect.Effect<CatalogResponse, ApiError>;
  readonly createDocument: (
    request: CreateDocumentRequest,
  ) => Effect.Effect<DocumentResponse, ApiError>;
  readonly allocateRfc: (documentId: string) => Effect.Effect<DocumentMetadataDto, ApiError>;
  readonly readDocument: (
    documentId: string,
    published?: boolean,
  ) => Effect.Effect<DocumentResponse, ApiError>;
  readonly listDocumentHistory: (
    documentId: string,
  ) => Effect.Effect<DocumentHistoryResponse, ApiError>;
  readonly readDocumentHistoryRevision: (
    documentId: string,
    revision: number,
  ) => Effect.Effect<DocumentResponse, ApiError>;
  readonly restoreDocumentHistoryRevision: (
    documentId: string,
    revision: number,
    expectedRevision: number,
  ) => Effect.Effect<DocumentResponse, ApiError>;
  readonly uploadAttachment: (
    documentId: string,
    file: File,
  ) => Effect.Effect<AttachmentMetadataDto, ApiError>;
  readonly updateMetadata: (
    documentId: string,
    request: Readonly<Record<string, unknown>>,
  ) => Effect.Effect<DocumentMetadataDto, ApiError>;
  readonly createThread: (
    documentId: string,
    anchor: CommentAnchorDto,
    body: string,
    authorDisplayName: string,
  ) => Effect.Effect<CommentStateDto, ApiError>;
  readonly editMessage: (
    documentId: string,
    threadId: string,
    messageId: string,
    body: string,
  ) => Effect.Effect<CommentStateDto, ApiError>;
  readonly deleteMessage: (
    documentId: string,
    threadId: string,
    messageId: string,
  ) => Effect.Effect<CommentStateDto, ApiError>;
  readonly deleteThread: (
    documentId: string,
    threadId: string,
  ) => Effect.Effect<CommentStateDto, ApiError>;
  readonly deleteDocument: (
    documentId: string,
    expectedRevision: number,
  ) => Effect.Effect<void, ApiError>;
  readonly restoreDocument: (
    documentId: string,
    expectedRevision: number,
  ) => Effect.Effect<DocumentMetadataDto, ApiError>;
  readonly hardDeleteDocument: (
    documentId: string,
    expectedRevision: number,
  ) => Effect.Effect<void, ApiError>;
  readonly moveToWorkspace: (
    documentId: string,
    expectedRevision: number,
  ) => Effect.Effect<DocumentMetadataDto, ApiError>;
  readonly makePersonal: (
    documentId: string,
    expectedRevision: number,
  ) => Effect.Effect<DocumentMetadataDto, ApiError>;
  readonly reply: (
    documentId: string,
    threadId: string,
    parentId: string,
    body: string,
    authorDisplayName: string,
  ) => Effect.Effect<CommentStateDto, ApiError>;
  readonly resolveThread: (
    documentId: string,
    threadId: string,
    resolved: boolean,
  ) => Effect.Effect<CommentStateDto, ApiError>;
  readonly listShareLinks: (documentId: string) => Effect.Effect<ShareLinksResponse, ApiError>;
  readonly createShareLink: (
    documentId: string,
    input: {
      readonly access: "view" | "comment" | "edit";
      readonly expectedRevision: number;
      readonly password?: string | undefined;
    },
  ) => Effect.Effect<ShareLinksResponse, ApiError>;
  readonly deleteShareLink: (
    documentId: string,
    shareId: string,
    expectedRevision: number,
  ) => Effect.Effect<ShareLinksResponse, ApiError>;
  readonly unlockShareLink: (
    documentId: string,
    password: string,
  ) => Effect.Effect<ShareUnlockResponse, ApiError>;
  /** Replaces the people a personal document is shared with. */
  readonly sharePersonalDocument: (
    documentId: string,
    emails: readonly string[],
    expectedRevision: number,
  ) => Effect.Effect<DocumentMetadataDto, ApiError>;
  readonly publish: (documentId: string) => Effect.Effect<DocumentMetadataDto, ApiError>;
  readonly unpublish: (documentId: string) => Effect.Effect<DocumentMetadataDto, ApiError>;
  readonly readPublicRfc: (number: number) => Effect.Effect<PublicDocumentResponse, ApiError>;
  /** Resolves `rfc:` and `doc:` reference keys for the current reader. */
  readonly resolveReferences: (
    references: readonly string[],
  ) => Effect.Effect<ReferenceResolutionsResponse, ApiError>;
}

export const ApiClient = Context.GenericTag<ApiClientService>("@earendil-works/inkling/ApiClient");

export function apiClientLayer(capabilityToken?: string): Layer.Layer<ApiClientService> {
  return Layer.succeed(ApiClient, makeApiClient(capabilityToken));
}

/**
 * Remembers authentication statuses between route loads in one page, per
 * capability token, so navigating does not ask again each time. Signing
 * out, or any request refused with 401, forgets them.
 */
export interface AuthenticationCache {
  readonly forget: () => void;
  readonly get: (key: string) => AuthenticationStatus | undefined;
  readonly set: (key: string, status: AuthenticationStatus) => void;
}

export function makeAuthenticationCache(): AuthenticationCache {
  const statuses = new Map<string, AuthenticationStatus>();
  return {
    forget: () => statuses.clear(),
    get: (key) => statuses.get(key),
    set: (key, status) => {
      statuses.set(key, status);
    },
  };
}

/** Sends an API request for a same-origin path; `fetch` in the browser. */
export type ApiTransport = (path: string, init: RequestInit) => Promise<Response>;

export function makeApiClient(
  capabilityToken?: string,
  transport: ApiTransport = (path, init) => fetch(path, init),
  authentication?: AuthenticationCache,
): ApiClientService {
  const authenticationKey = capabilityToken ?? "";
  const withCapability = (url: string): string => {
    if (capabilityToken === undefined) {
      return url;
    }
    // Only the path and query are used, so any base works.
    const parsed = new URL(url, "http://inkling.invalid");
    parsed.searchParams.set("cap", capabilityToken);
    return `${parsed.pathname}${parsed.search}`;
  };

  const request = <A, I>(
    url: string,
    schema: Schema.Schema<A, I>,
    init?: RequestInit,
  ): Effect.Effect<A, ApiError> =>
    Effect.tryPromise({
      catch: (cause) =>
        new ApiError({
          cause,
          code: "network_error",
          message: "Inkling is unreachable.",
          retryable: true,
          status: 0,
        }),
      try: () => {
        const currentCsrf = init?.method === undefined ? undefined : csrfToken();
        return transport(withCapability(url), {
          ...init,
          headers: {
            Accept: "application/json",
            ...(init?.body === undefined ? {} : { "Content-Type": "application/json" }),
            ...(currentCsrf === undefined ? {} : { "X-CSRF-Token": currentCsrf }),
            ...init?.headers,
          },
        });
      },
    }).pipe(
      Effect.flatMap((response) =>
        Effect.tryPromise({
          catch: (cause) =>
            new ApiError({
              cause,
              code: "invalid_response",
              message: "Inkling returned an unreadable response.",
              retryable: false,
              status: response.status,
            }),
          try: () => response.json() as Promise<unknown>,
        }).pipe(
          Effect.flatMap((body) =>
            response.ok
              ? Schema.decodeUnknown(schema)(body).pipe(
                  Effect.mapError(
                    (cause) =>
                      new ApiError({
                        cause,
                        code: "invalid_response",
                        message: "Inkling returned an unexpected response.",
                        retryable: false,
                        status: response.status,
                      }),
                  ),
                )
              : Schema.decodeUnknown(ProtocolErrorSchema)(body).pipe(
                  Effect.flatMap((error) =>
                    Effect.fail(
                      new ApiError({
                        code: error.code,
                        message: error.message,
                        retryable: error.retryable,
                        status: response.status,
                      }),
                    ),
                  ),
                  Effect.mapError((error) =>
                    error instanceof ApiError
                      ? error
                      : new ApiError({
                          cause: error,
                          code: "request_failed",
                          message: `Inkling rejected the request (${response.status}).`,
                          retryable: response.status >= 500,
                          status: response.status,
                        }),
                  ),
                ),
          ),
        ),
      ),
      // A refused request means a remembered status may be stale.
      Effect.tapError((error) =>
        error.status === 401 ? Effect.sync(() => authentication?.forget()) : Effect.void,
      ),
    );

  const mutation = <A, I>(
    url: string,
    schema: Schema.Schema<A, I>,
    method: "DELETE" | "PATCH" | "POST" | "PUT",
    body?: unknown,
  ): Effect.Effect<A, ApiError> =>
    request(url, schema, {
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      method,
    });

  return {
    allocateRfc: (documentId) =>
      mutation(
        `/api/documents/${encodeURIComponent(documentId)}/rfc`,
        DocumentMetadataSchema,
        "POST",
      ),
    authenticationStatus: Effect.suspend(() => {
      const cached = authentication?.get(authenticationKey);
      return cached === undefined
        ? request("/api/auth/status", AuthenticationStatusSchema).pipe(
            Effect.tap((status) =>
              Effect.sync(() => authentication?.set(authenticationKey, status)),
            ),
          )
        : Effect.succeed(cached);
    }),
    createApiKey: (label) => mutation("/api/api-keys", ApiKeyCreatedSchema, "POST", { label }),
    createDocument: (input) => mutation("/api/documents", DocumentResponseSchema, "POST", input),
    createThread: (documentId, anchor, body, authorDisplayName) =>
      mutation(
        `/api/documents/${encodeURIComponent(documentId)}/comments`,
        CommentStateSchema,
        "POST",
        {
          anchor,
          authorDisplayName,
          body,
        },
      ),
    deleteMessage: (documentId, threadId, messageId) =>
      mutation(
        `/api/documents/${encodeURIComponent(documentId)}/comments/${encodeURIComponent(threadId)}/messages/${encodeURIComponent(messageId)}`,
        CommentStateSchema,
        "DELETE",
      ),
    deleteThread: (documentId, threadId) =>
      mutation(
        `/api/documents/${encodeURIComponent(documentId)}/comments/${encodeURIComponent(threadId)}`,
        CommentStateSchema,
        "DELETE",
      ),
    deleteDocument: (documentId, expectedRevision) =>
      mutation(
        `/api/documents/${encodeURIComponent(documentId)}?expectedRevision=${expectedRevision}`,
        Schema.Unknown,
        "DELETE",
      ).pipe(Effect.asVoid),
    hardDeleteDocument: (documentId, expectedRevision) =>
      mutation(
        `/api/documents/${encodeURIComponent(documentId)}/permanent?expectedRevision=${expectedRevision}`,
        Schema.Unknown,
        "DELETE",
      ).pipe(Effect.asVoid),
    makePersonal: (documentId, expectedRevision) =>
      mutation(
        `/api/documents/${encodeURIComponent(documentId)}/personal?expectedRevision=${expectedRevision}`,
        DocumentMetadataSchema,
        "POST",
      ),
    moveToWorkspace: (documentId, expectedRevision) =>
      mutation(
        `/api/documents/${encodeURIComponent(documentId)}/workspace?expectedRevision=${expectedRevision}`,
        DocumentMetadataSchema,
        "POST",
      ),
    editMessage: (documentId, threadId, messageId, body) =>
      mutation(
        `/api/documents/${encodeURIComponent(documentId)}/comments/${encodeURIComponent(threadId)}/messages/${encodeURIComponent(messageId)}`,
        CommentStateSchema,
        "PATCH",
        { body },
      ),
    listApiKeys: request("/api/api-keys", Schema.Array(ApiKeySchema)),
    listDeletedDocuments: request("/api/trash", CatalogResponseSchema),
    listDocumentHistory: (documentId) =>
      request(
        `/api/documents/${encodeURIComponent(documentId)}/history`,
        DocumentHistoryResponseSchema,
      ),
    listDocuments: (query = "") =>
      request(`/api/documents?q=${encodeURIComponent(query)}`, CatalogResponseSchema),
    listPublicDocuments: (query = "") =>
      request(`/api/public/documents?q=${encodeURIComponent(query)}`, CatalogResponseSchema),
    logout: mutation("/api/auth/logout", Schema.Unknown, "POST").pipe(
      Effect.ensuring(Effect.sync(() => authentication?.forget())),
      Effect.asVoid,
    ),
    publish: (documentId) =>
      mutation(
        `/api/documents/${encodeURIComponent(documentId)}/publish`,
        DocumentMetadataSchema,
        "POST",
      ),
    readDocument: (documentId, published = false) =>
      request(
        `/api/documents/${encodeURIComponent(documentId)}${published ? "?published=true" : ""}`,
        DocumentResponseSchema,
      ),
    readDocumentHistoryRevision: (documentId, revision) =>
      request(
        `/api/documents/${encodeURIComponent(documentId)}/history/${revision}`,
        DocumentResponseSchema,
      ),
    readPublicRfc: (number) => request(`/api/public/rfc/${number}`, PublicDocumentResponseSchema),
    resolveReferences: (references) =>
      Effect.forEach(
        chunks([...new Set(references)], referencesPerRequest),
        (keys) =>
          request(
            `/api/references?${keys.map((key) => `ref=${encodeURIComponent(key)}`).join("&")}`,
            ReferenceResolutionsResponseSchema,
          ),
        { concurrency: 4 },
      ).pipe(
        Effect.map((responses) => ({
          references: Object.assign({}, ...responses.map((response) => response.references)),
        })),
      ),
    revealApiKey: (keyId) =>
      request(`/api/api-keys/${encodeURIComponent(keyId)}`, ApiKeyCreatedSchema),
    reply: (documentId, threadId, parentId, body, authorDisplayName) =>
      mutation(
        `/api/documents/${encodeURIComponent(documentId)}/comments/${encodeURIComponent(threadId)}/replies`,
        CommentStateSchema,
        "POST",
        { authorDisplayName, body, parentId },
      ),
    revokeApiKey: (keyId) =>
      mutation(`/api/api-keys/${encodeURIComponent(keyId)}`, Schema.Unknown, "DELETE").pipe(
        Effect.asVoid,
      ),
    resolveThread: (documentId, threadId, resolved) =>
      mutation(
        `/api/documents/${encodeURIComponent(documentId)}/comments/${encodeURIComponent(threadId)}/resolution`,
        CommentStateSchema,
        "PATCH",
        { resolved },
      ),
    restoreDocument: (documentId, expectedRevision) =>
      mutation(
        `/api/documents/${encodeURIComponent(documentId)}/restore?expectedRevision=${expectedRevision}`,
        DocumentMetadataSchema,
        "POST",
      ),
    restoreDocumentHistoryRevision: (documentId, revision, expectedRevision) =>
      mutation(
        `/api/documents/${encodeURIComponent(documentId)}/history/${revision}/restore`,
        DocumentResponseSchema,
        "POST",
        { expectedRevision },
      ),
    unpublish: (documentId) =>
      mutation(
        `/api/documents/${encodeURIComponent(documentId)}/unpublish`,
        DocumentMetadataSchema,
        "POST",
      ),
    uploadAttachment: (documentId, file) =>
      request(
        `/api/documents/${encodeURIComponent(documentId)}/attachments`,
        AttachmentMetadataSchema,
        {
          body: file,
          headers: { "Content-Type": file.type, "X-Inkling-Filename": file.name },
          method: "POST",
        },
      ),
    updateMetadata: (documentId, body) =>
      mutation(
        `/api/documents/${encodeURIComponent(documentId)}/metadata`,
        DocumentMetadataSchema,
        "PATCH",
        body,
      ),
    createShareLink: (documentId, body) =>
      mutation(
        `/api/documents/${encodeURIComponent(documentId)}/shares`,
        ShareLinksResponseSchema,
        "POST",
        body,
      ),
    deleteShareLink: (documentId, shareId, expectedRevision) =>
      mutation(
        `/api/documents/${encodeURIComponent(documentId)}/shares/${encodeURIComponent(shareId)}?expectedRevision=${expectedRevision}`,
        ShareLinksResponseSchema,
        "DELETE",
      ),
    listShareLinks: (documentId) =>
      request(`/api/documents/${encodeURIComponent(documentId)}/shares`, ShareLinksResponseSchema),
    sharePersonalDocument: (documentId, emails, expectedRevision) =>
      mutation(
        `/api/documents/${encodeURIComponent(documentId)}/people`,
        DocumentMetadataSchema,
        "PUT",
        { emails, expectedRevision },
      ),
    unlockShareLink: (documentId, password) =>
      mutation(
        `/api/documents/${encodeURIComponent(documentId)}/shares/unlock`,
        ShareUnlockResponseSchema,
        "POST",
        { password },
      ),
  };
}

function csrfToken(): string | undefined {
  const entry = document.cookie
    .split(";")
    .map((item) => item.trim())
    .find((item) => item.startsWith("inkling_csrf="));
  return entry === undefined ? undefined : decodeURIComponent(entry.slice("inkling_csrf=".length));
}
