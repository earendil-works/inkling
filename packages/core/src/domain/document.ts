import { Data, Effect, Either } from "effect";

declare const opaqueDocumentId: unique symbol;
declare const opaquePersonId: unique symbol;
declare const opaqueRevision: unique symbol;
declare const opaqueAttachmentId: unique symbol;

export type DocumentId = string & { readonly [opaqueDocumentId]: true };
export type PersonId = string & { readonly [opaquePersonId]: true };
export type DocumentRevision = number & { readonly [opaqueRevision]: true };
export type AttachmentId = string & { readonly [opaqueAttachmentId]: true };

export const knownLifecycleStates = [
  "draft",
  "discussion",
  "published",
  "accepted",
  "implemented",
  "abandoned",
] as const;

export type KnownLifecycleState = (typeof knownLifecycleStates)[number];
export type LifecycleState = KnownLifecycleState | (string & {});
export type Visibility = "public" | "workspace";
export type Sensitivity = "normal" | "confidential";
export type CapabilityAccess = "disabled" | "view" | "comment" | "edit";

export interface PersonReference {
  readonly id: PersonId;
  readonly displayName: string;
  readonly email: string;
}

export interface RelatedDocumentReference {
  readonly documentId: DocumentId;
  readonly relationship?: string | undefined;
}

export interface SharingPolicy {
  readonly access: CapabilityAccess;
  readonly generation: number;
  readonly expiresAt?: string | undefined;
}

/** Security-sensitive metadata owned by a document authority, never by Markdown. */
export interface DocumentMetadata {
  readonly id: DocumentId;
  readonly rfcNumber?: number | undefined;
  readonly title: string;
  /** Unknown imported states are deliberately preserved. */
  readonly lifecycleState: LifecycleState;
  readonly visibility: Visibility;
  readonly sensitivity: Sensitivity;
  readonly labels: readonly string[];
  readonly authors: readonly PersonReference[];
  readonly reviewers: readonly PersonReference[];
  readonly approvers: readonly PersonReference[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly targetDecisionDate?: string | undefined;
  readonly relatedDocuments: readonly RelatedDocumentReference[];
  readonly legacySourceUrl?: string | undefined;
  readonly headRevision: DocumentRevision;
  readonly publishedRevision?: DocumentRevision | undefined;
  readonly sharing: SharingPolicy;
  readonly deletedAt?: string | undefined;
}

export interface AttachmentMetadata {
  readonly id: AttachmentId;
  readonly documentId: DocumentId;
  readonly originalFilename: string;
  readonly mediaType: string;
  readonly size: number;
  readonly digest: string;
  readonly createdAt: string;
  readonly uploader: PersonReference;
  readonly width?: number | undefined;
  readonly height?: number | undefined;
}

export interface CreateMetadataInput {
  readonly id: string;
  readonly rfcNumber?: number | undefined;
  readonly title: string;
  readonly lifecycleState?: string | undefined;
  readonly visibility?: Visibility | undefined;
  readonly sensitivity?: Sensitivity | undefined;
  readonly labels?: readonly string[] | undefined;
  readonly authors?: readonly PersonReference[] | undefined;
  readonly reviewers?: readonly PersonReference[] | undefined;
  readonly approvers?: readonly PersonReference[] | undefined;
  readonly createdAt?: string | undefined;
  readonly targetDecisionDate?: string | undefined;
  readonly relatedDocuments?: readonly RelatedDocumentReference[] | undefined;
  readonly legacySourceUrl?: string | undefined;
}

export interface MetadataPatch {
  readonly title?: string | undefined;
  readonly lifecycleState?: string | undefined;
  readonly visibility?: Visibility | undefined;
  readonly sensitivity?: Sensitivity | undefined;
  readonly labels?: readonly string[] | undefined;
  readonly authors?: readonly PersonReference[] | undefined;
  readonly reviewers?: readonly PersonReference[] | undefined;
  readonly approvers?: readonly PersonReference[] | undefined;
  readonly targetDecisionDate?: string | null | undefined;
  readonly relatedDocuments?: readonly RelatedDocumentReference[] | undefined;
  readonly legacySourceUrl?: string | null | undefined;
}

export class DomainError extends Data.TaggedError("DomainError")<{
  readonly code: string;
  readonly message: string;
}> {}

export function documentId(value: string): Effect.Effect<DocumentId, DomainError> {
  return /^[A-Za-z0-9_-]{10,128}$/u.test(value)
    ? Effect.succeed(value as DocumentId)
    : fail("invalid_document_id", "Document identifiers must be opaque URL-safe values.");
}

export function personId(value: string): Effect.Effect<PersonId, DomainError> {
  return /^[A-Za-z0-9_.@+-]{3,256}$/u.test(value)
    ? Effect.succeed(value as PersonId)
    : fail("invalid_person_id", "Person identifiers must be stable non-empty values.");
}

export function attachmentId(value: string): Effect.Effect<AttachmentId, DomainError> {
  return /^[A-Za-z0-9_-]{10,128}$/u.test(value)
    ? Effect.succeed(value as AttachmentId)
    : fail("invalid_attachment_id", "Attachment identifiers must be URL-safe values.");
}

export function documentRevision(value: number): Effect.Effect<DocumentRevision, DomainError> {
  return Number.isSafeInteger(value) && value >= 0
    ? Effect.succeed(value as DocumentRevision)
    : fail("invalid_revision", "Document revisions must be non-negative integers.");
}

export function nextDocumentRevision(value: DocumentRevision): DocumentRevision {
  return (value + 1) as DocumentRevision;
}

export function hasPendingPublicationChanges(metadata: {
  readonly headRevision: number;
  readonly publishedRevision?: number | undefined;
}): boolean {
  return (
    metadata.publishedRevision === undefined ||
    metadata.headRevision > metadata.publishedRevision + 1
  );
}

export function validatePerson(person: PersonReference): Effect.Effect<void, DomainError> {
  if (person.displayName.trim().length === 0 || person.displayName.length > 200) {
    return fail("invalid_person", "A person must have a display name.");
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(person.email) || person.email.length > 320) {
    return fail("invalid_person", "A person must have a valid email address.");
  }
  return Effect.void;
}

export function createDocumentMetadata(
  input: CreateMetadataInput,
  now: string,
): Effect.Effect<DocumentMetadata, DomainError> {
  return Effect.gen(function* () {
    const id = yield* documentId(input.id);
    const createdAt = input.createdAt ?? now;
    const title = yield* fromEither(validateTitle(input.title));
    const lifecycleState = yield* fromEither(
      validateLifecycleState(input.lifecycleState ?? "draft"),
    );
    const labels = yield* fromEither(normalizeLabels(input.labels ?? []));
    const authors = yield* validatePeople(input.authors ?? []);
    const reviewers = yield* validatePeople(input.reviewers ?? []);
    const approvers = yield* validatePeople(input.approvers ?? []);
    const relatedDocuments = yield* fromEither(
      validateRelatedDocuments(input.relatedDocuments ?? []),
    );
    const createdDate = yield* fromEither(validateDate(createdAt, "creation date"));
    const updatedDate = yield* fromEither(validateDate(now, "update date"));
    const targetDecisionDate =
      input.targetDecisionDate === undefined
        ? undefined
        : yield* fromEither(validateDate(input.targetDecisionDate, "target decision date"));
    const legacySourceUrl =
      input.legacySourceUrl === undefined
        ? undefined
        : yield* fromEither(validateHttpUrl(input.legacySourceUrl, "legacy source URL"));

    if (
      input.rfcNumber !== undefined &&
      (!Number.isSafeInteger(input.rfcNumber) || input.rfcNumber < 1)
    ) {
      return yield* fail("invalid_rfc_number", "RFC numbers must be positive integers.");
    }

    return {
      approvers,
      authors,
      createdAt: createdDate,
      headRevision: 0 as DocumentRevision,
      id,
      labels,
      legacySourceUrl,
      lifecycleState,
      relatedDocuments,
      reviewers,
      rfcNumber: input.rfcNumber,
      sensitivity: input.sensitivity ?? "normal",
      sharing: { access: "disabled", generation: 0 },
      targetDecisionDate,
      title,
      updatedAt: updatedDate,
      visibility: input.visibility ?? "workspace",
    };
  });
}

export function assignRfcNumber(
  metadata: DocumentMetadata,
  rfcNumber: number,
  now: string,
): Effect.Effect<DocumentMetadata, DomainError> {
  if (!Number.isSafeInteger(rfcNumber) || rfcNumber < 1) {
    return fail("invalid_rfc_number", "RFC numbers must be positive integers.");
  }
  if (metadata.rfcNumber !== undefined) {
    return metadata.rfcNumber === rfcNumber
      ? Effect.succeed(metadata)
      : fail("rfc_already_allocated", "The document already has a different RFC number.");
  }
  return Effect.succeed({
    ...metadata,
    headRevision: nextDocumentRevision(metadata.headRevision),
    rfcNumber,
    updatedAt: now,
  });
}

export function updateDocumentMetadata(
  metadata: DocumentMetadata,
  patch: MetadataPatch,
  expectedRevision: number,
  now: string,
  confirmConfidentialPublic = false,
): Effect.Effect<DocumentMetadata, DomainError> {
  return Effect.gen(function* () {
    yield* requireRevision(metadata, expectedRevision);
    const visibility = patch.visibility ?? metadata.visibility;
    const sensitivity = patch.sensitivity ?? metadata.sensitivity;

    if (visibility === "public" && sensitivity === "confidential" && !confirmConfidentialPublic) {
      return yield* fail(
        "confidential_public_confirmation_required",
        "Publishing confidential metadata requires explicit confirmation.",
      );
    }

    const targetDecisionDate =
      patch.targetDecisionDate === undefined
        ? metadata.targetDecisionDate
        : patch.targetDecisionDate === null
          ? undefined
          : yield* fromEither(validateDate(patch.targetDecisionDate, "target decision date"));
    const legacySourceUrl =
      patch.legacySourceUrl === undefined
        ? metadata.legacySourceUrl
        : patch.legacySourceUrl === null
          ? undefined
          : yield* fromEither(validateHttpUrl(patch.legacySourceUrl, "legacy source URL"));

    return {
      ...metadata,
      approvers:
        patch.approvers === undefined ? metadata.approvers : yield* validatePeople(patch.approvers),
      authors:
        patch.authors === undefined ? metadata.authors : yield* validatePeople(patch.authors),
      headRevision: nextDocumentRevision(metadata.headRevision),
      labels:
        patch.labels === undefined
          ? metadata.labels
          : yield* fromEither(normalizeLabels(patch.labels)),
      legacySourceUrl,
      lifecycleState:
        patch.lifecycleState === undefined
          ? metadata.lifecycleState
          : yield* fromEither(validateLifecycleState(patch.lifecycleState)),
      relatedDocuments:
        patch.relatedDocuments === undefined
          ? metadata.relatedDocuments
          : yield* fromEither(validateRelatedDocuments(patch.relatedDocuments)),
      reviewers:
        patch.reviewers === undefined ? metadata.reviewers : yield* validatePeople(patch.reviewers),
      sensitivity,
      targetDecisionDate,
      title:
        patch.title === undefined ? metadata.title : yield* fromEither(validateTitle(patch.title)),
      updatedAt: yield* fromEither(validateDate(now, "update date")),
      visibility,
    };
  });
}

export function updateSharingPolicy(
  metadata: DocumentMetadata,
  access: CapabilityAccess,
  expectedRevision: number,
  now: string,
  expiresAt?: string,
): Effect.Effect<DocumentMetadata, DomainError> {
  return Effect.gen(function* () {
    yield* requireRevision(metadata, expectedRevision);
    const expiry =
      expiresAt === undefined
        ? undefined
        : yield* fromEither(validateDate(expiresAt, "capability expiry"));
    return {
      ...metadata,
      headRevision: nextDocumentRevision(metadata.headRevision),
      sharing: {
        access,
        expiresAt: expiry,
        generation: metadata.sharing.generation + 1,
      },
      updatedAt: yield* fromEither(validateDate(now, "update date")),
    };
  });
}

export function markPublished(
  metadata: DocumentMetadata,
  revision: DocumentRevision,
  now: string,
): Effect.Effect<DocumentMetadata, DomainError> {
  if (revision > metadata.headRevision) {
    return fail("invalid_publication", "A future revision cannot be published.");
  }
  return fromEither(validateDate(now, "publication date")).pipe(
    Effect.map((updatedAt) => ({
      ...metadata,
      headRevision: nextDocumentRevision(metadata.headRevision),
      publishedRevision: revision,
      updatedAt,
    })),
  );
}

export function markUnpublished(
  metadata: DocumentMetadata,
  now: string,
): Effect.Effect<DocumentMetadata, DomainError> {
  return fromEither(validateDate(now, "update date")).pipe(
    Effect.map((updatedAt) => ({
      ...metadata,
      headRevision: nextDocumentRevision(metadata.headRevision),
      publishedRevision: undefined,
      updatedAt,
    })),
  );
}

export function markDeleted(
  metadata: DocumentMetadata,
  expectedRevision: number,
  now: string,
): Effect.Effect<DocumentMetadata, DomainError> {
  return Effect.gen(function* () {
    yield* requireRevision(metadata, expectedRevision);
    const deletedAt = yield* fromEither(validateDate(now, "deletion date"));
    return {
      ...metadata,
      deletedAt,
      headRevision: nextDocumentRevision(metadata.headRevision),
      sharing: {
        access: "disabled",
        generation: metadata.sharing.generation + 1,
      },
      updatedAt: deletedAt,
    };
  });
}

export function requireRevision(
  metadata: DocumentMetadata,
  expectedRevision: number,
): Effect.Effect<void, DomainError> {
  return metadata.headRevision === expectedRevision
    ? Effect.void
    : fail(
        "revision_conflict",
        `Expected revision ${expectedRevision}, current revision is ${metadata.headRevision}.`,
      );
}

function validateTitle(value: string): Either.Either<string, DomainError> {
  const title = value.trim();
  return title.length > 0 && title.length <= 300
    ? Either.right(title)
    : invalid("invalid_title", "Titles must contain between 1 and 300 characters.");
}

function validateLifecycleState(value: string): Either.Either<LifecycleState, DomainError> {
  const state = value.trim();
  return state.length > 0 && state.length <= 100
    ? Either.right(state as LifecycleState)
    : invalid("invalid_state", "Lifecycle states must contain between 1 and 100 characters.");
}

function normalizeLabels(values: readonly string[]): Either.Either<readonly string[], DomainError> {
  const labels = [...new Set(values.map((value) => value.trim()).filter(Boolean))];
  return labels.length <= 100 && labels.every((label) => label.length <= 100)
    ? Either.right(labels.toSorted((left, right) => left.localeCompare(right)))
    : invalid("invalid_labels", "Documents may have up to 100 labels of 100 characters.");
}

function validatePeople(
  values: readonly PersonReference[],
): Effect.Effect<readonly PersonReference[], DomainError> {
  return Effect.gen(function* () {
    const seen = new Set<string>();
    for (const value of values) {
      yield* validatePerson(value);
      if (seen.has(value.id)) {
        return yield* fail("duplicate_person", `Person ${value.id} occurs more than once.`);
      }
      seen.add(value.id);
    }
    return [...values];
  });
}

function validateRelatedDocuments(
  values: readonly RelatedDocumentReference[],
): Either.Either<readonly RelatedDocumentReference[], DomainError> {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value.documentId)) {
      return invalid(
        "duplicate_related_document",
        `Document ${value.documentId} occurs more than once.`,
      );
    }
    seen.add(value.documentId);
  }
  return Either.right([...values]);
}

function validateDate(value: string, label: string): Either.Either<string, DomainError> {
  return Number.isFinite(Date.parse(value))
    ? Either.right(value)
    : invalid("invalid_date", `The ${label} is not a valid ISO date.`);
}

function validateHttpUrl(value: string, label: string): Either.Either<string, DomainError> {
  return Either.try({
    catch: () =>
      new DomainError({ code: "invalid_url", message: `The ${label} is not a valid URL.` }),
    try: () => new URL(value),
  }).pipe(
    Either.flatMap((url) =>
      url.protocol === "https:" || url.protocol === "http:"
        ? Either.right(url.href)
        : invalid("invalid_url", `The ${label} must use HTTP or HTTPS.`),
    ),
  );
}

function fromEither<A>(either: Either.Either<A, DomainError>): Effect.Effect<A, DomainError> {
  return Either.match(either, {
    onLeft: Effect.fail,
    onRight: Effect.succeed,
  });
}

function invalid<A = never>(code: string, message: string): Either.Either<A, DomainError> {
  return Either.left(new DomainError({ code, message }));
}

function fail<A = never>(code: string, message: string): Effect.Effect<A, DomainError> {
  return Effect.fail(new DomainError({ code, message }));
}
