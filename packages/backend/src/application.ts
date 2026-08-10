import { Context, Data, type Effect, type Stream } from "effect";

import type {
  CatalogSummary,
  PeopleDirectoryEntry,
  PersonReference,
  Principal,
  WorkspaceIdentity,
} from "@earendil-works/inkling-core";
import type {
  ApiKeyCreated,
  ApiKeyDto,
  AttachmentMetadataDto,
  AuthenticationStatus,
  CatalogResponse,
  CommentStateDto,
  CreateDocumentRequest,
  CreateThreadRequest,
  DocumentMetadataDto,
  DocumentResponse,
  EditBodyRequest,
  EditMessageRequest,
  ImportDocumentRequest,
  MetadataPatchRequest,
  PublicDocumentResponse,
  ReplaceBodyRequest,
  ReplyRequest,
  ResolutionRequest,
  ShareLinkCreateRequest,
  ShareLinksResponse,
  ShareUnlockResponse,
  ServerCollaborationMessage,
} from "@earendil-works/inkling-protocol";

export interface RequestCredentials {
  /** Trusted principal supplied only by an internal runtime adapter. */
  readonly internalPrincipal?: Principal | undefined;
  readonly bearerToken?: string | undefined;
  readonly sessionToken?: string | undefined;
  readonly capabilityToken?: string | undefined;
  readonly capabilityProof?: string | undefined;
  readonly guestName?: string | undefined;
}

export function shareProofCookieName(capabilityId: string): string | undefined {
  return /^[A-Za-z0-9_-]{3,128}$/u.test(capabilityId) ? `inkling_share_${capabilityId}` : undefined;
}

export function shareProofCookieNameFromToken(token: string | undefined): string | undefined {
  if (token === undefined) return undefined;
  const [prefix, , capabilityId, secret, extra] = token.split(".");
  return prefix === "cap" && secret !== undefined && extra === undefined
    ? shareProofCookieName(capabilityId ?? "")
    : undefined;
}

export interface CollaborationConnection {
  readonly principal: Principal;
  readonly welcome: ServerCollaborationMessage;
  readonly events: Stream.Stream<ServerCollaborationMessage>;
  readonly acceptUpdate: (
    update: Uint8Array,
    clientUpdateId: string,
  ) => Effect.Effect<ServerCollaborationMessage, ApplicationError>;
}

export interface ApplicationDiagnostics {
  readonly activeDocumentRooms: number;
  readonly dirtyDocuments: number;
  readonly generatedAt: string;
}

export interface BackupVerification {
  readonly checkedObjects: number;
  readonly errors: readonly string[];
}

export interface AttachmentContent {
  readonly bytes: Uint8Array;
  readonly metadata: AttachmentMetadataDto;
  readonly publicCache: boolean;
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

export interface DocumentRuntimeConfiguration {
  readonly capabilities: readonly {
    readonly access: "view" | "comment" | "edit";
    readonly documentId: string;
    readonly expiresAt?: string | undefined;
    readonly createdAt?: string | undefined;
    readonly generation: number;
    readonly id: string;
    readonly passwordHash?: string | undefined;
    readonly passwordProof?: string | undefined;
    readonly retainedSecret?: string | undefined;
    readonly tokenHash: string;
  }[];
  readonly workspaceId: string;
  readonly documentId: string;
  readonly rfcNumber?: number | undefined;
  readonly summary?: CatalogSummary | undefined;
}

export interface InklingApplicationService {
  /** Internal coordinator operations are exposed only through runtime bindings. */
  readonly authorizeRequest: (
    credentials: RequestCredentials,
    documentId?: string,
  ) => Effect.Effect<Principal, ApplicationError>;
  readonly documentRuntimeConfiguration: (
    documentId: string,
  ) => Effect.Effect<DocumentRuntimeConfiguration, ApplicationError>;
  readonly allDocumentRuntimeConfigurations: () => Effect.Effect<
    readonly DocumentRuntimeConfiguration[],
    ApplicationError
  >;
  readonly currentDocumentProjection: (
    documentId: string,
  ) => Effect.Effect<DocumentResponse, ApplicationError>;
  readonly applyDocumentProjection: (
    document: DocumentResponse,
  ) => Effect.Effect<void, ApplicationError>;
  readonly resolvePeople: (
    emails: readonly string[],
  ) => Effect.Effect<readonly PersonReference[], ApplicationError>;
  readonly markCatalogDeleted: (
    document: DocumentResponse,
  ) => Effect.Effect<void, ApplicationError>;
  readonly markCatalogRestored: (
    document: DocumentResponse,
  ) => Effect.Effect<void, ApplicationError>;
  readonly markCatalogPurged: (documentId: string) => Effect.Effect<void, ApplicationError>;
  readonly purgeExpiredDocuments: (
    now: string,
  ) => Effect.Effect<readonly string[], ApplicationError>;
  readonly releaseDocumentRoom: (documentId: string) => Effect.Effect<void>;
  /** Flushes all active document rooms to immutable checkpoints. */
  readonly checkpointAll: () => Effect.Effect<void, ApplicationError>;
  readonly exportWorkspace: (
    credentials: RequestCredentials,
  ) => Effect.Effect<Uint8Array, ApplicationError>;
  readonly restoreWorkspace: (
    credentials: RequestCredentials,
    archive: Uint8Array,
  ) => Effect.Effect<BackupVerification, ApplicationError>;
  readonly verifyWorkspace: (
    credentials: RequestCredentials,
  ) => Effect.Effect<BackupVerification, ApplicationError>;
  readonly diagnostics: (
    credentials: RequestCredentials,
  ) => Effect.Effect<ApplicationDiagnostics, ApplicationError>;
  readonly repairCatalog: (
    credentials: RequestCredentials,
  ) => Effect.Effect<BackupVerification, ApplicationError>;
  readonly uploadAttachment: (
    credentials: RequestCredentials,
    documentId: string,
    filename: string,
    mediaType: string,
    bytes: Uint8Array,
  ) => Effect.Effect<AttachmentMetadataDto, ApplicationError>;
  readonly listAttachments: (
    credentials: RequestCredentials,
    documentId: string,
  ) => Effect.Effect<readonly AttachmentMetadataDto[], ApplicationError>;
  readonly readAttachment: (
    credentials: RequestCredentials,
    documentId: string,
    attachmentId: string,
  ) => Effect.Effect<AttachmentContent, ApplicationError>;
  readonly connectCollaboration: (
    credentials: RequestCredentials,
    documentId: string,
    stateVector?: Uint8Array,
  ) => Effect.Effect<CollaborationConnection, ApplicationError>;
  readonly authenticationStatus: (
    credentials: RequestCredentials,
  ) => Effect.Effect<AuthenticationStatus, ApplicationError>;
  readonly loginWorkspaceIdentity: (
    identity: WorkspaceIdentity,
    people?: readonly PeopleDirectoryEntry[],
  ) => Effect.Effect<SessionResult, ApplicationError>;
  readonly logout: (credentials: RequestCredentials) => Effect.Effect<void, ApplicationError>;
  readonly listDocuments: (
    credentials: RequestCredentials,
    query: string,
  ) => Effect.Effect<CatalogResponse, ApplicationError>;
  readonly listDeletedDocuments: (
    credentials: RequestCredentials,
  ) => Effect.Effect<CatalogResponse, ApplicationError>;
  readonly listPublicDocuments: (
    query: string,
    lifecycleState?: string,
    label?: string,
  ) => Effect.Effect<CatalogResponse, ApplicationError>;
  readonly createDocument: (
    credentials: RequestCredentials,
    request: CreateDocumentRequest,
  ) => Effect.Effect<DocumentResponse, ApplicationError>;
  readonly reserveRfcNumber: (
    credentials: RequestCredentials,
    documentId: string,
  ) => Effect.Effect<number, ApplicationError>;
  readonly assignRfcNumber: (
    credentials: RequestCredentials,
    documentId: string,
    rfcNumber: number,
  ) => Effect.Effect<DocumentMetadataDto, ApplicationError>;
  readonly importDocument: (
    credentials: RequestCredentials,
    request: ImportDocumentRequest,
  ) => Effect.Effect<DocumentResponse, ApplicationError>;
  readonly readDocument: (
    credentials: RequestCredentials,
    documentId: string,
    startLine?: number,
    endLine?: number,
    published?: boolean,
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
  readonly restoreDocument: (
    credentials: RequestCredentials,
    documentId: string,
    expectedRevision: number,
  ) => Effect.Effect<DocumentMetadataDto, ApplicationError>;
  readonly hardDeleteDocument: (
    credentials: RequestCredentials,
    documentId: string,
    expectedRevision: number,
  ) => Effect.Effect<void, ApplicationError>;
  readonly listShareLinks: (
    credentials: RequestCredentials,
    documentId: string,
    baseUrl: string,
  ) => Effect.Effect<ShareLinksResponse, ApplicationError>;
  readonly createShareLink: (
    credentials: RequestCredentials,
    documentId: string,
    request: ShareLinkCreateRequest,
    baseUrl: string,
  ) => Effect.Effect<ShareLinksResponse, ApplicationError>;
  readonly deleteShareLink: (
    credentials: RequestCredentials,
    documentId: string,
    shareId: string,
    expectedRevision: number,
    baseUrl: string,
  ) => Effect.Effect<ShareLinksResponse, ApplicationError>;
  readonly unlockShareLink: (
    credentials: RequestCredentials,
    documentId: string,
    password: string,
  ) => Effect.Effect<
    ShareUnlockResponse & { readonly capabilityId: string; readonly proof: string },
    ApplicationError
  >;
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
  readonly readPublicDocument: (
    documentId: string,
  ) => Effect.Effect<PublicDocumentResponse, ApplicationError>;
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
  readonly revealApiKey: (
    credentials: RequestCredentials,
    keyId: string,
  ) => Effect.Effect<ApiKeyCreated, ApplicationError>;
  readonly revokeApiKey: (
    credentials: RequestCredentials,
    keyId: string,
  ) => Effect.Effect<void, ApplicationError>;
}

export const InklingApplication = Context.GenericTag<InklingApplicationService>(
  "@earendil-works/inkling/InklingApplication",
);
