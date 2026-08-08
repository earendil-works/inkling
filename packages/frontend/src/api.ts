import { Context, Data, Effect, Layer, Schema } from "effect";

import {
  ApiKeyCreatedSchema,
  ApiKeySchema,
  AttachmentMetadataSchema,
  AuthenticationStatusSchema,
  CatalogResponseSchema,
  CommentStateSchema,
  DocumentMetadataSchema,
  DocumentResponseSchema,
  ProtocolErrorSchema,
  PublicDocumentResponseSchema,
  ShareResponseSchema,
} from "@earendil-works/jot-protocol";
import type {
  ApiKeyCreated,
  ApiKeyDto,
  AttachmentMetadataDto,
  AuthenticationStatus,
  CatalogResponse,
  CommentAnchorDto,
  CommentStateDto,
  CreateDocumentRequest,
  DocumentMetadataDto,
  DocumentResponse,
  PublicDocumentResponse,
  ShareResponse,
} from "@earendil-works/jot-protocol";

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
  readonly revokeApiKey: (keyId: string) => Effect.Effect<void, ApiError>;
  readonly logout: Effect.Effect<void, ApiError>;
  readonly listDocuments: (query?: string) => Effect.Effect<CatalogResponse, ApiError>;
  readonly listPublicDocuments: (query?: string) => Effect.Effect<CatalogResponse, ApiError>;
  readonly createDocument: (
    request: CreateDocumentRequest,
  ) => Effect.Effect<DocumentResponse, ApiError>;
  readonly allocateRfc: (documentId: string) => Effect.Effect<DocumentMetadataDto, ApiError>;
  readonly readDocument: (
    documentId: string,
    published?: boolean,
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
  readonly updateShare: (
    documentId: string,
    access: "disabled" | "view" | "comment" | "edit",
    expectedRevision: number,
  ) => Effect.Effect<ShareResponse, ApiError>;
  readonly publish: (
    documentId: string,
    confirmConfidentialPublic?: boolean,
  ) => Effect.Effect<DocumentMetadataDto, ApiError>;
  readonly unpublish: (documentId: string) => Effect.Effect<DocumentMetadataDto, ApiError>;
  readonly readPublicRfc: (number: number) => Effect.Effect<PublicDocumentResponse, ApiError>;
}

export const ApiClient = Context.GenericTag<ApiClientService>("@earendil-works/jot/ApiClient");

export function apiClientLayer(capabilityToken?: string): Layer.Layer<ApiClientService> {
  return Layer.succeed(ApiClient, makeApiClient(capabilityToken));
}

export function makeApiClient(capabilityToken?: string): ApiClientService {
  const withCapability = (url: string): string => {
    if (capabilityToken === undefined) {
      return url;
    }
    const parsed = new URL(url, location.origin);
    parsed.searchParams.set("cap", capabilityToken);
    return `${parsed.pathname}${parsed.search}`;
  };

  const request = <A, I>(
    url: string,
    schema: Schema.Schema<A, I>,
    init?: RequestInit,
  ): Effect.Effect<A, ApiError> => {
    const currentCsrf = csrfToken();
    return Effect.tryPromise({
      catch: (cause) =>
        new ApiError({
          cause,
          code: "network_error",
          message: "Jot is unreachable.",
          retryable: true,
          status: 0,
        }),
      try: () =>
        fetch(withCapability(url), {
          ...init,
          headers: {
            Accept: "application/json",
            ...(init?.body === undefined ? {} : { "Content-Type": "application/json" }),
            ...(currentCsrf === undefined ? {} : { "X-CSRF-Token": currentCsrf }),
            ...init?.headers,
          },
        }),
    }).pipe(
      Effect.flatMap((response) =>
        Effect.tryPromise({
          catch: (cause) =>
            new ApiError({
              cause,
              code: "invalid_response",
              message: "Jot returned an unreadable response.",
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
                        message: "Jot returned an unexpected response.",
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
                          message: `Jot rejected the request (${response.status}).`,
                          retryable: response.status >= 500,
                          status: response.status,
                        }),
                  ),
                ),
          ),
        ),
      ),
    );
  };

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
    authenticationStatus: request("/api/auth/status", AuthenticationStatusSchema),
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
    editMessage: (documentId, threadId, messageId, body) =>
      mutation(
        `/api/documents/${encodeURIComponent(documentId)}/comments/${encodeURIComponent(threadId)}/messages/${encodeURIComponent(messageId)}`,
        CommentStateSchema,
        "PATCH",
        { body },
      ),
    listApiKeys: request("/api/api-keys", Schema.Array(ApiKeySchema)),
    listDocuments: (query = "") =>
      request(`/api/documents?q=${encodeURIComponent(query)}`, CatalogResponseSchema),
    listPublicDocuments: (query = "") =>
      request(`/api/public/documents?q=${encodeURIComponent(query)}`, CatalogResponseSchema),
    logout: mutation("/api/auth/logout", Schema.Unknown, "POST").pipe(Effect.asVoid),
    publish: (documentId, confirmConfidentialPublic = false) =>
      mutation(
        `/api/documents/${encodeURIComponent(documentId)}/publish${confirmConfidentialPublic ? "?confirmConfidentialPublic=true" : ""}`,
        DocumentMetadataSchema,
        "POST",
      ),
    readDocument: (documentId, published = false) =>
      request(
        `/api/documents/${encodeURIComponent(documentId)}${published ? "?published=true" : ""}`,
        DocumentResponseSchema,
      ),
    readPublicRfc: (number) => request(`/api/public/rfc/${number}`, PublicDocumentResponseSchema),
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
          headers: { "Content-Type": file.type, "X-Jot-Filename": file.name },
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
    updateShare: (documentId, access, expectedRevision) =>
      mutation(
        `/api/documents/${encodeURIComponent(documentId)}/share`,
        ShareResponseSchema,
        "PATCH",
        {
          access,
          expectedRevision,
        },
      ),
  };
}

function csrfToken(): string | undefined {
  const entry = document.cookie
    .split(";")
    .map((item) => item.trim())
    .find((item) => item.startsWith("jot_csrf="));
  return entry === undefined ? undefined : decodeURIComponent(entry.slice("jot_csrf=".length));
}
