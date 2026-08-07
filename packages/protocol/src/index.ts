import { Data, Effect, Schema } from "effect";

export const protocolVersion = 1;

const NonEmptyString = Schema.String.pipe(Schema.minLength(1));
const Revision = Schema.Number.pipe(Schema.int(), Schema.nonNegative());
const PositiveInteger = Schema.Number.pipe(Schema.int(), Schema.positive());

export const HealthResponseSchema = Schema.Struct({
  protocolVersion: Schema.Number,
  service: Schema.Literal("jot"),
  status: Schema.Literal("ok"),
  version: Schema.String,
});
export type HealthResponse = typeof HealthResponseSchema.Type;

export const ProtocolErrorSchema = Schema.Struct({
  code: Schema.String,
  currentRevision: Schema.optional(Revision),
  message: Schema.String,
  retryable: Schema.Boolean,
});
export type ProtocolError = typeof ProtocolErrorSchema.Type;

export const PersonSchema = Schema.Struct({
  displayName: NonEmptyString,
  email: NonEmptyString,
  id: NonEmptyString,
});
export type PersonDto = typeof PersonSchema.Type;

export const SharingPolicySchema = Schema.Struct({
  access: Schema.Literal("disabled", "view", "comment", "edit"),
  expiresAt: Schema.optional(Schema.String),
  generation: Revision,
});
export type SharingPolicyDto = typeof SharingPolicySchema.Type;

export const RelatedDocumentSchema = Schema.Struct({
  documentId: NonEmptyString,
  relationship: Schema.optional(Schema.String),
});

export const DocumentMetadataSchema = Schema.Struct({
  approvers: Schema.Array(PersonSchema),
  authors: Schema.Array(PersonSchema),
  createdAt: Schema.String,
  deletedAt: Schema.optional(Schema.String),
  headRevision: Revision,
  id: NonEmptyString,
  labels: Schema.Array(Schema.String),
  legacySourceUrl: Schema.optional(Schema.String),
  lifecycleState: NonEmptyString,
  publishedRevision: Schema.optional(Revision),
  relatedDocuments: Schema.Array(RelatedDocumentSchema),
  reviewers: Schema.Array(PersonSchema),
  rfcNumber: Schema.optional(PositiveInteger),
  sensitivity: Schema.Literal("normal", "confidential"),
  sharing: SharingPolicySchema,
  targetDecisionDate: Schema.optional(Schema.String),
  title: NonEmptyString,
  updatedAt: Schema.String,
  visibility: Schema.Literal("public", "workspace"),
});
export type DocumentMetadataDto = typeof DocumentMetadataSchema.Type;

export const CommentAnchorSchema = Schema.Struct({
  end: Schema.String,
  orphaned: Schema.Boolean,
  originalEnd: Revision,
  originalStart: Revision,
  prefix: Schema.String,
  quote: Schema.String,
  start: Schema.String,
  suffix: Schema.String,
});
export type CommentAnchorDto = typeof CommentAnchorSchema.Type;

export const CommentMessageSchema = Schema.Struct({
  authorDisplayName: Schema.String,
  authorId: Schema.String,
  body: Schema.String,
  createdAt: Schema.String,
  deletedAt: Schema.optional(Schema.String),
  id: Schema.String,
  parentId: Schema.optional(Schema.String),
  updatedAt: Schema.String,
});
export type CommentMessageDto = typeof CommentMessageSchema.Type;

export const CommentThreadSchema = Schema.Struct({
  anchor: CommentAnchorSchema,
  createdAt: Schema.String,
  id: Schema.String,
  messages: Schema.Array(CommentMessageSchema),
  resolved: Schema.Boolean,
  updatedAt: Schema.String,
});
export type CommentThreadDto = typeof CommentThreadSchema.Type;

export const CommentStateSchema = Schema.Struct({
  revision: Revision,
  threads: Schema.Array(CommentThreadSchema),
});
export type CommentStateDto = typeof CommentStateSchema.Type;

export const DocumentResponseSchema = Schema.Struct({
  body: Schema.String,
  comments: CommentStateSchema,
  metadata: DocumentMetadataSchema,
  sequence: Revision,
});
export type DocumentResponse = typeof DocumentResponseSchema.Type;

export const DocumentSummarySchema = Schema.Struct({
  excerpt: Schema.String,
  metadata: DocumentMetadataSchema,
});
export type DocumentSummary = typeof DocumentSummarySchema.Type;

export const CatalogResponseSchema = Schema.Struct({
  documents: Schema.Array(DocumentSummarySchema),
});
export type CatalogResponse = typeof CatalogResponseSchema.Type;

export const CreateDocumentRequestSchema = Schema.Struct({
  allocateRfc: Schema.optional(Schema.Boolean),
  body: Schema.optional(Schema.String),
  creationKey: NonEmptyString,
  requestedRfcNumber: Schema.optional(PositiveInteger),
  title: NonEmptyString,
});
export type CreateDocumentRequest = typeof CreateDocumentRequestSchema.Type;

export const ImportedCommentMessageSchema = Schema.Struct({
  authorDisplayName: NonEmptyString,
  body: NonEmptyString,
  createdAt: Schema.optional(Schema.String),
  legacyId: Schema.optional(Schema.String),
  parentLegacyId: Schema.optional(Schema.String),
  updatedAt: Schema.optional(Schema.String),
});

export const ImportedCommentThreadSchema = Schema.Struct({
  legacyId: Schema.optional(Schema.String),
  messages: Schema.Array(ImportedCommentMessageSchema).pipe(Schema.minItems(1)),
  originalEnd: Schema.optional(Revision),
  originalStart: Schema.optional(Revision),
  prefix: Schema.String,
  quote: Schema.String,
  resolved: Schema.Boolean,
  suffix: Schema.String,
});

export const ImportDocumentRequestSchema = Schema.Struct({
  body: Schema.String,
  comments: Schema.optional(Schema.Array(ImportedCommentThreadSchema)),
  metadata: Schema.Struct({
    approvers: Schema.optional(Schema.Array(PersonSchema)),
    authors: Schema.optional(Schema.Array(PersonSchema)),
    createdAt: Schema.optional(Schema.String),
    id: Schema.optional(NonEmptyString),
    labels: Schema.optional(Schema.Array(Schema.String)),
    legacySourceUrl: Schema.optional(Schema.String),
    lifecycleState: Schema.optional(NonEmptyString),
    relatedDocuments: Schema.optional(Schema.Array(RelatedDocumentSchema)),
    reviewers: Schema.optional(Schema.Array(PersonSchema)),
    rfcNumber: Schema.optional(PositiveInteger),
    sensitivity: Schema.optional(Schema.Literal("normal", "confidential")),
    targetDecisionDate: Schema.optional(Schema.String),
    title: NonEmptyString,
    updatedAt: Schema.optional(Schema.String),
    visibility: Schema.optional(Schema.Literal("public", "workspace")),
  }),
  people: Schema.optional(
    Schema.Array(
      Schema.Struct({
        aliases: Schema.optional(Schema.Array(Schema.String)),
        displayName: NonEmptyString,
        email: NonEmptyString,
      }),
    ),
  ),
  publish: Schema.optional(Schema.Boolean),
});
export type ImportDocumentRequest = typeof ImportDocumentRequestSchema.Type;

export const MetadataPatchRequestSchema = Schema.Struct({
  approvers: Schema.optional(Schema.Array(PersonSchema)),
  authors: Schema.optional(Schema.Array(PersonSchema)),
  confirmConfidentialPublic: Schema.optional(Schema.Boolean),
  expectedRevision: Revision,
  labels: Schema.optional(Schema.Array(Schema.String)),
  legacySourceUrl: Schema.optional(Schema.NullOr(Schema.String)),
  lifecycleState: Schema.optional(NonEmptyString),
  relatedDocuments: Schema.optional(Schema.Array(RelatedDocumentSchema)),
  reviewers: Schema.optional(Schema.Array(PersonSchema)),
  sensitivity: Schema.optional(Schema.Literal("normal", "confidential")),
  targetDecisionDate: Schema.optional(Schema.NullOr(Schema.String)),
  visibility: Schema.optional(Schema.Literal("public", "workspace")),
});
export type MetadataPatchRequest = typeof MetadataPatchRequestSchema.Type;

export const TextReplacementSchema = Schema.Struct({
  newText: Schema.String,
  oldText: NonEmptyString,
});

export const EditBodyRequestSchema = Schema.Struct({
  edits: Schema.Array(TextReplacementSchema).pipe(Schema.minItems(1)),
  expectedRevision: Revision,
});
export type EditBodyRequest = typeof EditBodyRequestSchema.Type;

export const ReplaceBodyRequestSchema = Schema.Struct({
  body: Schema.String,
  expectedRevision: Revision,
});
export type ReplaceBodyRequest = typeof ReplaceBodyRequestSchema.Type;

export const ShareUpdateRequestSchema = Schema.Struct({
  access: Schema.Literal("disabled", "view", "comment", "edit"),
  expectedRevision: Revision,
  expiresAt: Schema.optional(Schema.String),
});
export type ShareUpdateRequest = typeof ShareUpdateRequestSchema.Type;

export const ShareResponseSchema = Schema.Struct({
  capabilityUrl: Schema.optional(Schema.String),
  policy: SharingPolicySchema,
});
export type ShareResponse = typeof ShareResponseSchema.Type;

export const PublicationResponseSchema = Schema.Struct({
  metadata: DocumentMetadataSchema,
  publishedAt: Schema.String,
});
export type PublicationResponse = typeof PublicationResponseSchema.Type;

export const PublicDocumentResponseSchema = Schema.Struct({
  canonicalPath: Schema.String,
  description: Schema.String,
  headings: Schema.Array(
    Schema.Struct({ depth: Schema.Number, id: Schema.String, text: Schema.String }),
  ),
  html: Schema.String,
  metadata: DocumentMetadataSchema,
});
export type PublicDocumentResponse = typeof PublicDocumentResponseSchema.Type;

export const AttachmentMetadataSchema = Schema.Struct({
  createdAt: Schema.String,
  digest: Schema.String,
  filename: NonEmptyString,
  height: Schema.optional(PositiveInteger),
  id: NonEmptyString,
  mediaType: NonEmptyString,
  size: Revision,
  uploaderId: NonEmptyString,
  url: Schema.String,
  width: Schema.optional(PositiveInteger),
});
export type AttachmentMetadataDto = typeof AttachmentMetadataSchema.Type;

export const AttachmentListResponseSchema = Schema.Struct({
  attachments: Schema.Array(AttachmentMetadataSchema),
});
export type AttachmentListResponse = typeof AttachmentListResponseSchema.Type;

export const BackupVerificationSchema = Schema.Struct({
  checkedObjects: Revision,
  errors: Schema.Array(Schema.String),
});
export type BackupVerificationDto = typeof BackupVerificationSchema.Type;

export const CreateThreadRequestSchema = Schema.Union(
  Schema.Struct({
    anchor: CommentAnchorSchema,
    authorDisplayName: NonEmptyString,
    body: NonEmptyString,
  }),
  Schema.Struct({
    authorDisplayName: NonEmptyString,
    body: NonEmptyString,
    selection: Schema.Struct({ end: Revision, start: Revision }),
  }),
);
export type CreateThreadRequest = typeof CreateThreadRequestSchema.Type;

export const ReplyRequestSchema = Schema.Struct({
  authorDisplayName: NonEmptyString,
  body: NonEmptyString,
  parentId: NonEmptyString,
});
export type ReplyRequest = typeof ReplyRequestSchema.Type;

export const EditMessageRequestSchema = Schema.Struct({ body: NonEmptyString });
export type EditMessageRequest = typeof EditMessageRequestSchema.Type;

export const ResolutionRequestSchema = Schema.Struct({ resolved: Schema.Boolean });
export type ResolutionRequest = typeof ResolutionRequestSchema.Type;

export const AuthenticationStatusSchema = Schema.Struct({
  authenticationMethods: Schema.Array(Schema.Literal("password", "google")),
  authenticated: Schema.Boolean,
  needsSetup: Schema.Boolean,
  principal: Schema.optional(
    Schema.Struct({
      displayName: Schema.String,
      email: Schema.optional(Schema.String),
      id: Schema.String,
      role: Schema.String,
    }),
  ),
});
export type AuthenticationStatus = typeof AuthenticationStatusSchema.Type;

export const PasswordRequestSchema = Schema.Struct({
  password: Schema.String.pipe(Schema.minLength(12)),
});
export type PasswordRequest = typeof PasswordRequestSchema.Type;

export const ApiKeyCreateRequestSchema = Schema.Struct({ label: NonEmptyString });
export type ApiKeyCreateRequest = typeof ApiKeyCreateRequestSchema.Type;

export const ApiKeySchema = Schema.Struct({
  createdAt: Schema.String,
  id: Schema.String,
  label: Schema.String,
  lastUsedAt: Schema.optional(Schema.String),
  revokedAt: Schema.optional(Schema.String),
});
export type ApiKeyDto = typeof ApiKeySchema.Type;

export const ApiKeyCreatedSchema = Schema.Struct({ key: Schema.String, metadata: ApiKeySchema });
export type ApiKeyCreated = typeof ApiKeyCreatedSchema.Type;

export const PresenceSchema = Schema.Struct({
  color: Schema.String.pipe(Schema.maxLength(32)),
  displayName: NonEmptyString.pipe(Schema.maxLength(200)),
  participantId: NonEmptyString.pipe(Schema.maxLength(128)),
  selectionEnd: Schema.optional(Revision),
  selectionStart: Schema.optional(Revision),
});
export type PresenceDto = typeof PresenceSchema.Type;

export const ClientCollaborationMessageSchema = Schema.Union(
  Schema.Struct({
    protocolVersion: Schema.Literal(protocolVersion),
    stateVector: Schema.optional(Schema.String.pipe(Schema.maxLength(1_600_000))),
    type: Schema.Literal("hello"),
  }),
  Schema.Struct({
    clientUpdateId: NonEmptyString.pipe(Schema.maxLength(200)),
    type: Schema.Literal("body-update"),
    update: NonEmptyString.pipe(Schema.maxLength(1_600_000)),
  }),
  Schema.Struct({ presence: PresenceSchema, type: Schema.Literal("presence") }),
);
export type ClientCollaborationMessage = typeof ClientCollaborationMessageSchema.Type;

export const ServerCollaborationMessageSchema = Schema.Union(
  Schema.Struct({
    actions: Schema.Array(Schema.String),
    comments: CommentStateSchema,
    metadata: DocumentMetadataSchema,
    protocolVersion: Schema.Literal(protocolVersion),
    sequence: Revision,
    stateUpdate: Schema.String,
    type: Schema.Literal("welcome"),
  }),
  Schema.Struct({
    clientUpdateId: Schema.String,
    documentRevision: Revision,
    serverSequence: Revision,
    type: Schema.Literal("update-accepted"),
    update: Schema.optional(Schema.String),
  }),
  Schema.Struct({ presence: PresenceSchema, type: Schema.Literal("presence") }),
  Schema.Struct({
    comments: CommentStateSchema,
    revision: Revision,
    type: Schema.Literal("comments-changed"),
  }),
  Schema.Struct({ metadata: DocumentMetadataSchema, type: Schema.Literal("metadata-changed") }),
  Schema.Struct({
    actions: Schema.Array(Schema.String),
    type: Schema.Literal("permission-changed"),
  }),
  Schema.Struct({ reason: Schema.String, type: Schema.Literal("resynchronize") }),
  Schema.Struct({ error: ProtocolErrorSchema, type: Schema.Literal("error") }),
);
export type ServerCollaborationMessage = typeof ServerCollaborationMessageSchema.Type;

export class ProtocolDecodeError extends Data.TaggedError("ProtocolDecodeError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

export function decodeUnknown<A, I, R>(
  schema: Schema.Schema<A, I, R>,
  input: unknown,
): Effect.Effect<A, ProtocolDecodeError, R> {
  return Schema.decodeUnknown(schema)(input).pipe(
    Effect.mapError(
      (cause) =>
        new ProtocolDecodeError({
          cause,
          message: "The request does not match the protocol schema.",
        }),
    ),
  );
}

export function decodeJson<A, I, R>(
  schema: Schema.Schema<A, I, R>,
  input: string,
): Effect.Effect<A, ProtocolDecodeError, R> {
  return Schema.decodeUnknown(Schema.parseJson(schema))(input).pipe(
    Effect.mapError(
      (cause) =>
        new ProtocolDecodeError({ cause, message: "The message is not valid protocol JSON." }),
    ),
  );
}

export function encodeJson<A, I, R>(
  schema: Schema.Schema<A, I, R>,
  input: A,
): Effect.Effect<string, ProtocolDecodeError, R> {
  return Schema.encode(Schema.parseJson(schema))(input).pipe(
    Effect.mapError(
      (cause) => new ProtocolDecodeError({ cause, message: "The response cannot be encoded." }),
    ),
  );
}
