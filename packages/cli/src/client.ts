import { Data, Effect, Schema } from "effect";

import { identifierTag, taggedId, uuidV7Bytes } from "@earendil-works/inkling-core";
import {
  AttachmentListResponseSchema,
  AttachmentMetadataSchema,
  BackupVerificationSchema,
  CatalogResponseSchema,
  CommentStateSchema,
  DocumentMetadataSchema,
  DocumentResponseSchema,
  ProtocolErrorSchema,
  ShareLinksResponseSchema,
} from "@earendil-works/inkling-protocol";
import type {
  AttachmentMetadataDto,
  BackupVerificationDto,
  CatalogResponse,
  CommentStateDto,
  DocumentMetadataDto,
  DocumentResponse,
  ImportDocumentRequest,
  ShareLinksResponse,
} from "@earendil-works/inkling-protocol";

import type { Instance } from "./config.ts";

export class ClientError extends Data.TaggedError("ClientError")<{
  readonly code: string;
  readonly message: string;
  readonly status: number;
  readonly cause?: unknown;
}> {}

export interface CliClient {
  readonly exportWorkspace: Effect.Effect<Uint8Array, ClientError>;
  readonly restoreWorkspace: (
    archive: Uint8Array,
  ) => Effect.Effect<BackupVerificationDto, ClientError>;
  readonly verifyWorkspace: Effect.Effect<BackupVerificationDto, ClientError>;
  readonly repairCatalog: Effect.Effect<BackupVerificationDto, ClientError>;
  readonly uploadAttachment: (
    documentId: string,
    filename: string,
    mediaType: string,
    bytes: Uint8Array,
  ) => Effect.Effect<AttachmentMetadataDto, ClientError>;
  readonly listAttachments: (
    documentId: string,
  ) => Effect.Effect<readonly AttachmentMetadataDto[], ClientError>;
  readonly downloadAttachment: (
    documentId: string,
    attachmentId: string,
  ) => Effect.Effect<Uint8Array, ClientError>;
  readonly importDocument: (
    request: ImportDocumentRequest,
  ) => Effect.Effect<DocumentResponse, ClientError>;
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
  readonly replaceBody: (
    documentId: string,
    body: string,
    expectedRevision: number,
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
  readonly listShareLinks: (documentId: string) => Effect.Effect<ShareLinksResponse, ClientError>;
  readonly createShareLink: (
    documentId: string,
    access: "view" | "comment" | "edit",
    expectedRevision: number,
  ) => Effect.Effect<ShareLinksResponse, ClientError>;
  readonly deleteShareLink: (
    documentId: string,
    shareId: string,
    expectedRevision: number,
  ) => Effect.Effect<ShareLinksResponse, ClientError>;
  readonly editComment: (
    documentId: string,
    threadId: string,
    messageId: string,
    body: string,
  ) => Effect.Effect<CommentStateDto, ClientError>;
  readonly deleteComment: (
    documentId: string,
    threadId: string,
    messageId: string,
  ) => Effect.Effect<CommentStateDto, ClientError>;
  readonly deleteThread: (
    documentId: string,
    threadId: string,
  ) => Effect.Effect<CommentStateDto, ClientError>;
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
              message: "Inkling returned unreadable JSON.",
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
                        message: "Inkling returned an unexpected response.",
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
                          message: `Inkling rejected the request (${response.status}).`,
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

  const binaryRequest = (resource: string): Effect.Effect<Uint8Array, ClientError> => {
    const url = new URL(resource, withTrailingSlash(instance.baseUrl));
    if (instance.capabilityToken !== undefined)
      url.searchParams.set("cap", instance.capabilityToken);
    return Effect.tryPromise({
      catch: (cause) =>
        new ClientError({
          cause,
          code: "network_error",
          message: `Cannot download from ${url.origin}.`,
          status: 0,
        }),
      try: async () => {
        const response = await fetch(
          url,
          instance.apiKey === undefined
            ? undefined
            : { headers: { Authorization: `Bearer ${instance.apiKey}` } },
        );
        if (!response.ok) {
          throw new Error(`Inkling rejected the download (${response.status}).`);
        }
        return new Uint8Array(await response.arrayBuffer());
      },
    });
  };

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
    exportWorkspace: binaryRequest("/api/admin/backup"),
    restoreWorkspace: (archive) =>
      request("/api/admin/restore", BackupVerificationSchema, {
        body: new Uint8Array(archive).buffer,
        headers: { "Content-Type": "application/json" },
        method: "POST",
      }),
    verifyWorkspace: request("/api/admin/verify", BackupVerificationSchema),
    repairCatalog: mutate("/api/admin/repair", BackupVerificationSchema, "POST"),
    downloadAttachment: (documentId, attachmentId) =>
      assertDocument(documentId).pipe(
        Effect.zipRight(
          binaryRequest(
            `/api/documents/${encodeURIComponent(documentId)}/attachments/${encodeURIComponent(attachmentId)}`,
          ),
        ),
      ),
    listAttachments: (documentId) =>
      assertDocument(documentId).pipe(
        Effect.zipRight(
          request(
            `/api/documents/${encodeURIComponent(documentId)}/attachments`,
            AttachmentListResponseSchema,
          ),
        ),
        Effect.map((response) => response.attachments),
      ),
    uploadAttachment: (documentId, filename, mediaType, bytes) =>
      assertDocument(documentId).pipe(
        Effect.zipRight(
          request(
            `/api/documents/${encodeURIComponent(documentId)}/attachments`,
            AttachmentMetadataSchema,
            {
              body: new Uint8Array(bytes).buffer,
              headers: { "Content-Type": mediaType, "X-Inkling-Filename": filename },
              method: "POST",
            },
          ),
        ),
      ),
    deleteComment: (documentId, threadId, messageId) =>
      assertDocument(documentId).pipe(
        Effect.zipRight(
          mutate(
            `/api/documents/${encodeURIComponent(documentId)}/comments/${encodeURIComponent(threadId)}/messages/${encodeURIComponent(messageId)}`,
            CommentStateSchema,
            "DELETE",
          ),
        ),
      ),
    deleteThread: (documentId, threadId) =>
      assertDocument(documentId).pipe(
        Effect.zipRight(
          mutate(
            `/api/documents/${encodeURIComponent(documentId)}/comments/${encodeURIComponent(threadId)}`,
            CommentStateSchema,
            "DELETE",
          ),
        ),
      ),
    editComment: (documentId, threadId, messageId, body) =>
      assertDocument(documentId).pipe(
        Effect.zipRight(
          mutate(
            `/api/documents/${encodeURIComponent(documentId)}/comments/${encodeURIComponent(threadId)}/messages/${encodeURIComponent(messageId)}`,
            CommentStateSchema,
            "PATCH",
            { body },
          ),
        ),
      ),
    comment: (documentId, start, end, body) =>
      assertDocument(documentId).pipe(
        Effect.zipRight(
          mutate(
            `/api/documents/${encodeURIComponent(documentId)}/comments`,
            CommentStateSchema,
            "POST",
            {
              authorDisplayName: process.env["INKLING_AUTHOR"] ?? "CLI agent",
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
        creationKey: taggedId(
          identifierTag.request,
          uuidV7Bytes(Date.now(), crypto.getRandomValues(new Uint8Array(10))),
        ),
        title,
      }),
    replaceBody: (documentId, body, expectedRevision) =>
      assertDocument(documentId).pipe(
        Effect.zipRight(
          mutate(
            `/api/documents/${encodeURIComponent(documentId)}/body`,
            DocumentResponseSchema,
            "PUT",
            { body, expectedRevision },
          ),
        ),
      ),
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
    importDocument: (input) => mutate("/api/admin/import", DocumentResponseSchema, "POST", input),
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
          authorDisplayName: process.env["INKLING_AUTHOR"] ?? "CLI agent",
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
    createShareLink: (documentId, access, expectedRevision) =>
      mutate(
        `/api/documents/${encodeURIComponent(documentId)}/shares`,
        ShareLinksResponseSchema,
        "POST",
        { access, expectedRevision },
      ),
    deleteShareLink: (documentId, shareId, expectedRevision) =>
      mutate(
        `/api/documents/${encodeURIComponent(documentId)}/shares/${encodeURIComponent(shareId)}?expectedRevision=${expectedRevision}`,
        ShareLinksResponseSchema,
        "DELETE",
      ),
    listShareLinks: (documentId) =>
      request(`/api/documents/${encodeURIComponent(documentId)}/shares`, ShareLinksResponseSchema),
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
