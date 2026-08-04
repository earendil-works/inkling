import { Data, Effect, Schema } from "effect";

import {
  CatalogResponseSchema,
  CommentStateSchema,
  DocumentMetadataSchema,
  DocumentResponseSchema,
  ProtocolErrorSchema,
  ShareResponseSchema,
} from "@earendil-works/jot-protocol";
import type {
  CatalogResponse,
  CommentStateDto,
  DocumentMetadataDto,
  DocumentResponse,
  ShareResponse,
} from "@earendil-works/jot-protocol";

import type { Instance } from "./config.ts";

export class ClientError extends Data.TaggedError("ClientError")<{
  readonly code: string;
  readonly message: string;
  readonly status: number;
  readonly cause?: unknown;
}> {}

export interface CliClient {
  readonly list: (query: string) => Effect.Effect<CatalogResponse, ClientError>;
  readonly read: (
    documentId: string,
    range?: { readonly start: number; readonly end: number },
  ) => Effect.Effect<DocumentResponse, ClientError>;
  readonly create: (
    title: string,
    body: string,
    allocateRfc: boolean,
  ) => Effect.Effect<DocumentResponse, ClientError>;
  readonly edit: (
    documentId: string,
    oldText: string,
    newText: string,
    expectedRevision: number,
  ) => Effect.Effect<DocumentResponse, ClientError>;
  readonly metadata: (
    documentId: string,
    patch: Readonly<Record<string, unknown>>,
  ) => Effect.Effect<DocumentMetadataDto, ClientError>;
  readonly remove: (
    documentId: string,
    expectedRevision: number,
  ) => Effect.Effect<void, ClientError>;
  readonly publish: (documentId: string) => Effect.Effect<DocumentMetadataDto, ClientError>;
  readonly unpublish: (documentId: string) => Effect.Effect<DocumentMetadataDto, ClientError>;
  readonly share: (
    documentId: string,
    access: string,
    expectedRevision: number,
  ) => Effect.Effect<ShareResponse, ClientError>;
  readonly comment: (
    documentId: string,
    start: number,
    end: number,
    body: string,
  ) => Effect.Effect<CommentStateDto, ClientError>;
  readonly reply: (
    documentId: string,
    threadId: string,
    parentId: string,
    body: string,
  ) => Effect.Effect<CommentStateDto, ClientError>;
  readonly resolve: (
    documentId: string,
    threadId: string,
    resolved: boolean,
  ) => Effect.Effect<CommentStateDto, ClientError>;
}

export function makeCliClient(instance: Instance): CliClient {
  const request = <A, I>(
    resource: string,
    schema: Schema.Schema<A, I>,
    init?: RequestInit,
  ): Effect.Effect<A, ClientError> => {
    const url = new URL(resource, withTrailingSlash(instance.baseUrl));
    if (instance.capabilityToken !== undefined) {
      url.searchParams.set("cap", instance.capabilityToken);
    }
    return Effect.tryPromise({
      catch: (cause) =>
        new ClientError({
          cause,
          code: "network_error",
          message: `Cannot reach ${url.origin}.`,
          status: 0,
        }),
      try: () =>
        fetch(url, {
          ...init,
          headers: {
            Accept: "application/json",
            ...(init?.body === undefined ? {} : { "Content-Type": "application/json" }),
            ...(instance.apiKey === undefined
              ? {}
              : { Authorization: `Bearer ${instance.apiKey}` }),
            ...init?.headers,
          },
        }),
    }).pipe(
      Effect.flatMap((response) =>
        Effect.tryPromise({
          catch: (cause) =>
            new ClientError({
              cause,
              code: "invalid_response",
              message: "Jot returned unreadable JSON.",
              status: response.status,
            }),
          try: () => response.json() as Promise<unknown>,
        }).pipe(
          Effect.flatMap((payload) =>
            response.ok
              ? Schema.decodeUnknown(schema)(payload).pipe(
                  Effect.mapError(
                    (cause) =>
                      new ClientError({
                        cause,
                        code: "invalid_response",
                        message: "Jot returned an unexpected response.",
                        status: response.status,
                      }),
                  ),
                )
              : Schema.decodeUnknown(ProtocolErrorSchema)(payload).pipe(
                  Effect.flatMap((error) =>
                    Effect.fail(
                      new ClientError({
                        code: error.code,
                        message: error.message,
                        status: response.status,
                      }),
                    ),
                  ),
                  Effect.mapError((error) =>
                    error instanceof ClientError
                      ? error
                      : new ClientError({
                          cause: error,
                          code: "request_failed",
                          message: `Jot rejected the request (${response.status}).`,
                          status: response.status,
                        }),
                  ),
                ),
          ),
        ),
      ),
    );
  };

  const mutate = <A, I>(
    resource: string,
    schema: Schema.Schema<A, I>,
    method: "DELETE" | "PATCH" | "POST" | "PUT",
    body?: unknown,
  ): Effect.Effect<A, ClientError> =>
    request(resource, schema, {
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      method,
    });

  const assertDocument = (documentId: string): Effect.Effect<void, ClientError> =>
    instance.documentId === undefined || instance.documentId === documentId
      ? Effect.void
      : Effect.fail(
          new ClientError({
            code: "shared_document_mismatch",
            message: `Instance ${instance.name} grants access only to ${instance.documentId}.`,
            status: 403,
          }),
        );

  return {
    comment: (documentId, start, end, body) =>
      assertDocument(documentId).pipe(
        Effect.zipRight(
          mutate(
            `/api/documents/${encodeURIComponent(documentId)}/comments`,
            CommentStateSchema,
            "POST",
            {
              authorDisplayName: process.env["JOT_AUTHOR"] ?? "CLI agent",
              body,
              selection: { end, start },
            },
          ),
        ),
      ),
    create: (title, body, allocateRfc) =>
      mutate("/api/documents", DocumentResponseSchema, "POST", {
        allocateRfc,
        body,
        creationKey: crypto.randomUUID(),
        title,
      }),
    edit: (documentId, oldText, newText, expectedRevision) =>
      assertDocument(documentId).pipe(
        Effect.zipRight(
          mutate(
            `/api/documents/${encodeURIComponent(documentId)}/edits`,
            DocumentResponseSchema,
            "POST",
            { edits: [{ newText, oldText }], expectedRevision },
          ),
        ),
      ),
    list: (query) =>
      request(`/api/documents?q=${encodeURIComponent(query)}`, CatalogResponseSchema),
    metadata: (documentId, patch) =>
      assertDocument(documentId).pipe(
        Effect.zipRight(
          mutate(
            `/api/documents/${encodeURIComponent(documentId)}/metadata`,
            DocumentMetadataSchema,
            "PATCH",
            patch,
          ),
        ),
      ),
    publish: (documentId) =>
      mutate(
        `/api/documents/${encodeURIComponent(documentId)}/publish`,
        DocumentMetadataSchema,
        "POST",
      ),
    read: (documentId, range) =>
      assertDocument(documentId).pipe(
        Effect.zipRight(
          request(
            `/api/documents/${encodeURIComponent(documentId)}${range === undefined ? "" : `?startLine=${range.start}&endLine=${range.end}`}`,
            DocumentResponseSchema,
          ),
        ),
      ),
    remove: (documentId, expectedRevision) =>
      mutate(
        `/api/documents/${encodeURIComponent(documentId)}?expectedRevision=${expectedRevision}`,
        Schema.Unknown,
        "DELETE",
      ).pipe(Effect.asVoid),
    reply: (documentId, threadId, parentId, body) =>
      mutate(
        `/api/documents/${encodeURIComponent(documentId)}/comments/${encodeURIComponent(threadId)}/replies`,
        CommentStateSchema,
        "POST",
        {
          authorDisplayName: process.env["JOT_AUTHOR"] ?? "CLI agent",
          body,
          parentId,
        },
      ),
    resolve: (documentId, threadId, resolved) =>
      mutate(
        `/api/documents/${encodeURIComponent(documentId)}/comments/${encodeURIComponent(threadId)}/resolution`,
        CommentStateSchema,
        "PATCH",
        { resolved },
      ),
    share: (documentId, access, expectedRevision) =>
      mutate(
        `/api/documents/${encodeURIComponent(documentId)}/share`,
        ShareResponseSchema,
        "PATCH",
        { access, expectedRevision },
      ),
    unpublish: (documentId) =>
      mutate(
        `/api/documents/${encodeURIComponent(documentId)}/unpublish`,
        DocumentMetadataSchema,
        "POST",
      ),
  };
}

function withTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}
