import { Context, Data, type Effect, type Stream } from "effect";

import type {
  ApiKeyCreated,
  ApiKeyDto,
  AuthenticationStatus,
  CatalogResponse,
  CommentStateDto,
  CreateDocumentRequest,
  CreateThreadRequest,
  DocumentMetadataDto,
  DocumentResponse,
  EditBodyRequest,
  EditMessageRequest,
  MetadataPatchRequest,
  PublicDocumentResponse,
  ReplaceBodyRequest,
  ReplyRequest,
  ResolutionRequest,
  ShareResponse,
  ShareUpdateRequest,
  ServerCollaborationMessage,
} from "@earendil-works/jot-protocol";

export interface RequestCredentials {
  readonly bearerToken?: string | undefined;
  readonly sessionToken?: string | undefined;
  readonly capabilityToken?: string | undefined;
  readonly guestName?: string | undefined;
}

export interface CollaborationConnection {
  readonly welcome: ServerCollaborationMessage;
  readonly events: Stream.Stream<ServerCollaborationMessage>;
  readonly acceptUpdate: (
    update: Uint8Array,
    clientUpdateId: string,
  ) => Effect.Effect<ServerCollaborationMessage, ApplicationError>;
}

export interface SessionResult {
  readonly csrfToken: string;
  readonly expiresAt: string;
  readonly sessionToken: string;
}

export class ApplicationError extends Data.TaggedError("ApplicationError")<{
  readonly code: string;
  readonly message: string;
  readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 429 | 500 | 503;
  readonly retryable: boolean;
  readonly currentRevision?: number | undefined;
  readonly cause?: unknown;
}> {}

export interface JotApplicationService {
  /** Flushes all active document rooms to immutable checkpoints. */
  readonly checkpointAll: () => Effect.Effect<void, ApplicationError>;
  readonly connectCollaboration: (
    credentials: RequestCredentials,
    documentId: string,
    stateVector?: Uint8Array,
  ) => Effect.Effect<CollaborationConnection, ApplicationError>;
  readonly authenticationStatus: (
    credentials: RequestCredentials,
  ) => Effect.Effect<AuthenticationStatus, ApplicationError>;
  readonly setupOwner: (password: string) => Effect.Effect<SessionResult, ApplicationError>;
  readonly login: (password: string) => Effect.Effect<SessionResult, ApplicationError>;
  readonly logout: (credentials: RequestCredentials) => Effect.Effect<void, ApplicationError>;
  readonly listDocuments: (
    credentials: RequestCredentials,
    query: string,
  ) => Effect.Effect<CatalogResponse, ApplicationError>;
  readonly createDocument: (
    credentials: RequestCredentials,
    request: CreateDocumentRequest,
  ) => Effect.Effect<DocumentResponse, ApplicationError>;
  readonly readDocument: (
    credentials: RequestCredentials,
    documentId: string,
    startLine?: number,
    endLine?: number,
  ) => Effect.Effect<DocumentResponse, ApplicationError>;
  readonly updateMetadata: (
    credentials: RequestCredentials,
    documentId: string,
    request: MetadataPatchRequest,
  ) => Effect.Effect<DocumentMetadataDto, ApplicationError>;
  readonly editBody: (
    credentials: RequestCredentials,
    documentId: string,
    request: EditBodyRequest,
  ) => Effect.Effect<DocumentResponse, ApplicationError>;
  readonly replaceBody: (
    credentials: RequestCredentials,
    documentId: string,
    request: ReplaceBodyRequest,
  ) => Effect.Effect<DocumentResponse, ApplicationError>;
  readonly deleteDocument: (
    credentials: RequestCredentials,
    documentId: string,
    expectedRevision: number,
  ) => Effect.Effect<void, ApplicationError>;
  readonly updateShare: (
    credentials: RequestCredentials,
    documentId: string,
    request: ShareUpdateRequest,
    baseUrl: string,
  ) => Effect.Effect<ShareResponse, ApplicationError>;
  readonly createThread: (
    credentials: RequestCredentials,
    documentId: string,
    request: CreateThreadRequest,
  ) => Effect.Effect<CommentStateDto, ApplicationError>;
  readonly reply: (
    credentials: RequestCredentials,
    documentId: string,
    threadId: string,
    request: ReplyRequest,
  ) => Effect.Effect<CommentStateDto, ApplicationError>;
  readonly editMessage: (
    credentials: RequestCredentials,
    documentId: string,
    threadId: string,
    messageId: string,
    request: EditMessageRequest,
  ) => Effect.Effect<CommentStateDto, ApplicationError>;
  readonly deleteMessage: (
    credentials: RequestCredentials,
    documentId: string,
    threadId: string,
    messageId: string,
  ) => Effect.Effect<CommentStateDto, ApplicationError>;
  readonly resolveThread: (
    credentials: RequestCredentials,
    documentId: string,
    threadId: string,
    request: ResolutionRequest,
  ) => Effect.Effect<CommentStateDto, ApplicationError>;
  readonly deleteThread: (
    credentials: RequestCredentials,
    documentId: string,
    threadId: string,
  ) => Effect.Effect<CommentStateDto, ApplicationError>;
  readonly publish: (
    credentials: RequestCredentials,
    documentId: string,
  ) => Effect.Effect<DocumentMetadataDto, ApplicationError>;
  readonly unpublish: (
    credentials: RequestCredentials,
    documentId: string,
  ) => Effect.Effect<DocumentMetadataDto, ApplicationError>;
  readonly readPublicRfc: (
    rfcNumber: number,
  ) => Effect.Effect<PublicDocumentResponse, ApplicationError>;
  readonly createApiKey: (
    credentials: RequestCredentials,
    label: string,
  ) => Effect.Effect<ApiKeyCreated, ApplicationError>;
  readonly listApiKeys: (
    credentials: RequestCredentials,
  ) => Effect.Effect<readonly ApiKeyDto[], ApplicationError>;
  readonly revokeApiKey: (
    credentials: RequestCredentials,
    keyId: string,
  ) => Effect.Effect<void, ApplicationError>;
}

export const JotApplication = Context.GenericTag<JotApplicationService>(
  "@earendil-works/jot/JotApplication",
);
