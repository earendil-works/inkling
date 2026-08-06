import { Context, Data, Effect, PubSub, Schema, Stream } from "effect";

import {
  applyUniqueTextReplacements,
  assignRfcNumber,
  authorizeDocument,
  createCommentThread,
  deleteCommentMessage,
  deleteCommentThread,
  Digest,
  DomainError,
  DurableDocumentJournal,
  editCommentMessage,
  emptyCommentState,
  markDeleted,
  markPublished,
  markUnpublished,
  nextDocumentRevision,
  ObjectStore,
  replaceCommentAnchor,
  replyToCommentThread,
  setCommentThreadResolution,
  updateDocumentMetadata,
  updateSharingPolicy,
} from "@earendil-works/jot-core";
import type {
  AuthorizationError,
  BodyEditError,
  CapabilityAccess,
  CommentActor,
  CommentState,
  CreateThreadInput,
  DocumentId,
  DocumentMetadata,
  DocumentRevision,
  JournalEntry,
  JournalEntryKind,
  MetadataPatch,
  Principal,
  StorageError,
  TextReplacement,
} from "@earendil-works/jot-core";

import {
  createCommentAnchor as createRelativeAnchor,
  reanchorAfterReplacement,
} from "./anchors.ts";
import { decodeBase64, encodeBase64 } from "./binary.ts";
import {
  applyDocumentUpdate,
  cloneDocument,
  CollaborationError,
  createCollaborativeDocument,
  destroyCollaborativeDocument,
  encodeDocumentState,
  encodeMissingState,
  encodeStateVector,
  replaceDocumentBody,
} from "./document.ts";
import type { CollaborativeDocument } from "./document.ts";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const maxUpdateBytes = 1_000_000;
const maxDocumentBytes = 5_000_000;

const checkpointWireSchema = Schema.Struct({
  body: Schema.optional(Schema.String),
  bodyUpdate: Schema.String,
  capturedAt: Schema.String,
  comments: Schema.Unknown,
  documentId: Schema.String,
  metadata: Schema.Unknown,
  schemaVersion: Schema.Literal(1),
  sequence: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  workspaceId: Schema.String,
});

const journalWireSchema = Schema.Struct({
  bodyUpdate: Schema.optional(Schema.String),
  comments: Schema.optional(Schema.Unknown),
  metadata: Schema.Unknown,
});

type CheckpointWire = typeof checkpointWireSchema.Type;

export interface DocumentSnapshot {
  readonly body: string;
  readonly comments: CommentState;
  readonly metadata: DocumentMetadata;
  readonly sequence: number;
  readonly stateUpdate: Uint8Array;
  readonly stateVector: Uint8Array;
}

export interface AcceptedBodyUpdate {
  readonly clientUpdateId: string;
  readonly revision: DocumentRevision;
  readonly sequence: number;
  readonly update: Uint8Array;
}

export type AuthorityEvent =
  | { readonly type: "body-update"; readonly accepted: AcceptedBodyUpdate }
  | { readonly type: "metadata-changed"; readonly metadata: DocumentMetadata }
  | {
      readonly type: "comments-changed";
      readonly comments: CommentState;
      readonly revision: DocumentRevision;
    }
  | { readonly type: "sharing-changed"; readonly metadata: DocumentMetadata }
  | { readonly type: "published"; readonly metadata: DocumentMetadata }
  | { readonly type: "resynchronize"; readonly reason: string };

export class RecoveryError extends Data.TaggedError("RecoveryError")<{
  readonly code: "checkpoint_corrupt" | "checkpoint_incompatible" | "document_missing";
  readonly message: string;
  readonly cause?: unknown;
}> {}

export type AuthorityError =
  | AuthorizationError
  | BodyEditError
  | CollaborationError
  | DomainError
  | RecoveryError
  | StorageError;

export interface DocumentAuthorityService {
  readonly documentId: DocumentId;
  readonly snapshot: (
    principal: Principal,
    now: string,
  ) => Effect.Effect<DocumentSnapshot, AuthorityError>;
  readonly synchronize: (
    principal: Principal,
    stateVector: Uint8Array,
    now: string,
  ) => Effect.Effect<DocumentSnapshot, AuthorityError>;
  readonly acceptBodyUpdate: (
    principal: Principal,
    update: Uint8Array,
    clientUpdateId: string,
    now: string,
  ) => Effect.Effect<AcceptedBodyUpdate, AuthorityError>;
  readonly replaceBody: (
    principal: Principal,
    body: string,
    expectedRevision: number,
    now: string,
  ) => Effect.Effect<AcceptedBodyUpdate, AuthorityError>;
  readonly applyTextEdits: (
    principal: Principal,
    edits: readonly TextReplacement[],
    expectedRevision: number,
    now: string,
  ) => Effect.Effect<AcceptedBodyUpdate, AuthorityError>;
  readonly assignRfcNumber: (
    principal: Principal,
    rfcNumber: number,
    now: string,
  ) => Effect.Effect<DocumentMetadata, AuthorityError>;
  readonly updateMetadata: (
    principal: Principal,
    patch: MetadataPatch,
    expectedRevision: number,
    now: string,
    confirmConfidentialPublic?: boolean,
  ) => Effect.Effect<DocumentMetadata, AuthorityError>;
  readonly updateSharing: (
    principal: Principal,
    access: CapabilityAccess,
    expectedRevision: number,
    now: string,
    expiresAt?: string,
  ) => Effect.Effect<DocumentMetadata, AuthorityError>;
  readonly createThread: (
    principal: Principal,
    input: CreateThreadInput,
    actor: CommentActor,
    now: string,
  ) => Effect.Effect<CommentState, AuthorityError>;
  readonly createThreadAtOffsets: (
    principal: Principal,
    input: {
      readonly id: string;
      readonly messageId: string;
      readonly body: string;
      readonly start: number;
      readonly end: number;
    },
    actor: CommentActor,
    now: string,
  ) => Effect.Effect<CommentState, AuthorityError>;
  readonly reply: (
    principal: Principal,
    threadId: string,
    messageId: string,
    parentId: string,
    body: string,
    actor: CommentActor,
    now: string,
  ) => Effect.Effect<CommentState, AuthorityError>;
  readonly editMessage: (
    principal: Principal,
    threadId: string,
    messageId: string,
    body: string,
    actor: CommentActor,
    now: string,
  ) => Effect.Effect<CommentState, AuthorityError>;
  readonly deleteMessage: (
    principal: Principal,
    threadId: string,
    messageId: string,
    actor: CommentActor,
    now: string,
  ) => Effect.Effect<CommentState, AuthorityError>;
  readonly setThreadResolution: (
    principal: Principal,
    threadId: string,
    resolved: boolean,
    now: string,
  ) => Effect.Effect<CommentState, AuthorityError>;
  readonly deleteThread: (
    principal: Principal,
    threadId: string,
    actor: CommentActor,
    now: string,
  ) => Effect.Effect<CommentState, AuthorityError>;
  readonly deleteDocument: (
    principal: Principal,
    expectedRevision: number,
    now: string,
  ) => Effect.Effect<DocumentMetadata, AuthorityError>;
  readonly publish: (
    principal: Principal,
    now: string,
  ) => Effect.Effect<DocumentMetadata, AuthorityError>;
  readonly unpublish: (
    principal: Principal,
    now: string,
  ) => Effect.Effect<DocumentMetadata, AuthorityError>;
  readonly checkpoint: (now: string) => Effect.Effect<void, AuthorityError>;
  readonly events: Stream.Stream<AuthorityEvent>;
  readonly close: Effect.Effect<void>;
}

export const DocumentAuthority = Context.GenericTag<DocumentAuthorityService>(
  "@earendil-works/jot/DocumentAuthority",
);

export interface MakeDocumentAuthorityOptions {
  readonly workspaceId: string;
  readonly documentId: DocumentId;
  readonly initialMetadata?: DocumentMetadata | undefined;
  readonly initialBody?: string | undefined;
}

interface MutableState {
  collaborative: CollaborativeDocument;
  metadata: DocumentMetadata;
  comments: CommentState;
  sequence: number;
  checkpointSequence: number;
  dirty: boolean;
}

export function makeDocumentAuthority(
  options: MakeDocumentAuthorityOptions,
): Effect.Effect<
  DocumentAuthorityService,
  RecoveryError | StorageError | CollaborationError,
  typeof ObjectStore.Service | typeof DurableDocumentJournal.Service | typeof Digest.Service
> {
  return Effect.gen(function* () {
    const objectStore = yield* ObjectStore;
    const journal = yield* DurableDocumentJournal;
    const digest = yield* Digest;
    const mutex = yield* Effect.makeSemaphore(1);
    const pubsub = yield* PubSub.unbounded<AuthorityEvent>();
    let state = yield* recoverState(options, objectStore, journal, digest);

    const withLock = mutex.withPermits(1);

    const persist = (
      kind: JournalEntryKind,
      metadata: DocumentMetadata,
      comments: CommentState,
      bodyUpdate: Uint8Array | undefined,
      idempotencyKey?: string,
    ): Effect.Effect<JournalEntry, StorageError> =>
      journal.append({
        documentId: options.documentId,
        idempotencyKey,
        kind,
        payload: encodeJournalWire(metadata, comments, bodyUpdate),
        previousSequence: state.sequence,
        revision: metadata.headRevision,
      });

    const commitBodyUpdateUnlocked = (
      update: Uint8Array,
      clientUpdateId: string,
      now: string,
      replacementComments: CommentState = state.comments,
    ): Effect.Effect<AcceptedBodyUpdate, AuthorityError> =>
      Effect.gen(function* () {
        if (update.byteLength > maxUpdateBytes) {
          return yield* collaborationFailure(
            "invalid_update",
            "The collaboration update is too large.",
          );
        }

        const cloned = yield* cloneDocument(state.collaborative.document);
        yield* applyDocumentUpdate(cloned, update);
        const clonedState = yield* encodeDocumentState(cloned);
        cloned.destroy();
        if (clonedState.byteLength > maxDocumentBytes) {
          return yield* collaborationFailure(
            "invalid_update",
            "The document exceeds its size limit.",
          );
        }

        const metadata: DocumentMetadata = {
          ...state.metadata,
          headRevision: nextDocumentRevision(state.metadata.headRevision),
          updatedAt: now,
        };
        const entry = yield* persist(
          "body-update",
          metadata,
          replacementComments,
          update,
          clientUpdateId,
        );

        if (entry.sequence > state.sequence) {
          const commentsChanged = replacementComments !== state.comments;
          yield* applyDocumentUpdate(state.collaborative.document, update);
          state = {
            ...state,
            comments: replacementComments,
            dirty: true,
            metadata,
            sequence: entry.sequence,
          };
          const accepted: AcceptedBodyUpdate = {
            clientUpdateId,
            revision: entry.revision,
            sequence: entry.sequence,
            update,
          };
          yield* PubSub.publish(pubsub, { accepted, type: "body-update" });
          if (commentsChanged) {
            yield* PubSub.publish(pubsub, {
              comments: replacementComments,
              revision: entry.revision,
              type: "comments-changed",
            });
          }
          return accepted;
        }
        return {
          clientUpdateId,
          revision: entry.revision,
          sequence: entry.sequence,
          update,
        };
      });

    const snapshot = (
      principal: Principal,
      now: string,
    ): Effect.Effect<DocumentSnapshot, AuthorityError> =>
      withLock(
        Effect.gen(function* () {
          yield* authorizeDocument(principal, "read-working", state.metadata, now);
          return yield* makeSnapshot(state);
        }),
      );

    const updateComments = (
      principal: Principal,
      now: string,
      operation: (
        comments: CommentState,
      ) => Effect.Effect<CommentState, DomainError | CollaborationError>,
    ): Effect.Effect<CommentState, AuthorityError> =>
      withLock(
        Effect.gen(function* () {
          yield* authorizeDocument(principal, "comment", state.metadata, now);
          const comments = yield* operation(state.comments);
          const metadata: DocumentMetadata = {
            ...state.metadata,
            headRevision: nextDocumentRevision(state.metadata.headRevision),
            updatedAt: now,
          };
          const entry = yield* persist("comment-event", metadata, comments, undefined);
          state = { ...state, comments, dirty: true, metadata, sequence: entry.sequence };
          yield* PubSub.publish(pubsub, {
            comments,
            revision: metadata.headRevision,
            type: "comments-changed",
          });
          return comments;
        }),
      );

    const authority: DocumentAuthorityService = {
      acceptBodyUpdate: (principal, update, clientUpdateId, now) =>
        withLock(
          Effect.suspend(() =>
            authorizeDocument(principal, "edit-body", state.metadata, now).pipe(
              Effect.flatMap(() => commitBodyUpdateUnlocked(update, clientUpdateId, now)),
            ),
          ),
        ),
      applyTextEdits: (principal, edits, expectedRevision, now) =>
        withLock(
          Effect.gen(function* () {
            yield* authorizeDocument(principal, "edit-body", state.metadata, now);
            if (state.metadata.headRevision !== expectedRevision) {
              return yield* Effect.fail(
                new DomainError({
                  code: "revision_conflict",
                  message: `Expected revision ${expectedRevision}, current revision is ${state.metadata.headRevision}.`,
                }),
              );
            }
            const replacement = yield* applyUniqueTextReplacements(
              state.collaborative.body.toString(),
              edits,
            );
            const update = yield* updateForReplacement(state.collaborative, replacement);
            return yield* commitBodyUpdateUnlocked(update, `agent-${expectedRevision}-${now}`, now);
          }),
        ),
      assignRfcNumber: (principal, rfcNumber, now) =>
        withLock(
          Effect.gen(function* () {
            yield* authorizeDocument(principal, "edit-metadata", state.metadata, now);
            const metadata = yield* assignRfcNumber(state.metadata, rfcNumber, now);
            if (metadata === state.metadata) return metadata;
            const entry = yield* persist("metadata-event", metadata, state.comments, undefined);
            state = { ...state, dirty: true, metadata, sequence: entry.sequence };
            yield* PubSub.publish(pubsub, { metadata, type: "metadata-changed" });
            return metadata;
          }),
        ),
      checkpoint: (now) =>
        checkpointState(
          options,
          () => state,
          (next) => (state = next),
          mutex,
          objectStore,
          journal,
          digest,
          now,
        ),
      close: destroyCollaborativeDocument(state.collaborative).pipe(
        Effect.zipRight(PubSub.shutdown(pubsub)),
      ),
      createThread: (principal, input, actor, now) =>
        updateComments(principal, now, (comments) =>
          createCommentThread(comments, input, actor, now),
        ),
      createThreadAtOffsets: (principal, input, actor, now) =>
        updateComments(principal, now, (comments) =>
          Effect.gen(function* () {
            const anchor = yield* createRelativeAnchor(
              state.collaborative.body,
              input.start,
              input.end,
            );
            return yield* createCommentThread(
              comments,
              {
                anchor,
                body: input.body,
                id: input.id,
                messageId: input.messageId,
              },
              actor,
              now,
            );
          }),
        ),
      deleteMessage: (principal, threadId, messageId, actor, now) =>
        updateComments(principal, now, (comments) =>
          deleteCommentMessage(comments, threadId, messageId, actor, now),
        ),
      deleteThread: (principal, threadId, actor, now) =>
        withLock(
          Effect.gen(function* () {
            yield* authorizeDocument(principal, "manage-comments", state.metadata, now);
            const comments = yield* deleteCommentThread(state.comments, threadId, actor);
            const metadata: DocumentMetadata = {
              ...state.metadata,
              headRevision: nextDocumentRevision(state.metadata.headRevision),
              updatedAt: now,
            };
            const entry = yield* persist("comment-event", metadata, comments, undefined);
            state = { ...state, comments, dirty: true, metadata, sequence: entry.sequence };
            yield* PubSub.publish(pubsub, {
              comments,
              revision: metadata.headRevision,
              type: "comments-changed",
            });
            return comments;
          }),
        ),
      deleteDocument: (principal, expectedRevision, now) =>
        withLock(
          Effect.gen(function* () {
            yield* authorizeDocument(principal, "delete", state.metadata, now);
            const metadata = yield* markDeleted(state.metadata, expectedRevision, now);
            const entry = yield* persist("metadata-event", metadata, state.comments, undefined);
            state = { ...state, dirty: true, metadata, sequence: entry.sequence };
            yield* PubSub.publish(pubsub, { metadata, type: "metadata-changed" });
            return metadata;
          }),
        ),
      documentId: options.documentId,
      editMessage: (principal, threadId, messageId, body, actor, now) =>
        updateComments(principal, now, (comments) =>
          editCommentMessage(comments, threadId, messageId, body, actor, now),
        ),
      events: Stream.fromPubSub(pubsub),
      publish: (principal, now) =>
        withLock(
          Effect.gen(function* () {
            yield* authorizeDocument(principal, "publish", state.metadata, now);
            const publishedRevision = state.metadata.headRevision;
            const checkpoint = yield* captureCheckpoint(options, state, now);
            const bytes = encodeCheckpoint(checkpoint);
            const objectDigest = yield* digest.sha256(bytes);
            yield* objectStore.put(revisionKey(options, publishedRevision), bytes, {
              digest: objectDigest,
              mediaType: "application/json",
            });
            const metadata = yield* markPublished(state.metadata, publishedRevision, now);
            const entry = yield* persist("publication-event", metadata, state.comments, undefined);
            state = { ...state, dirty: true, metadata, sequence: entry.sequence };
            yield* PubSub.publish(pubsub, { metadata, type: "published" });
            return metadata;
          }),
        ),
      replaceBody: (principal, body, expectedRevision, now) =>
        withLock(
          Effect.gen(function* () {
            yield* authorizeDocument(principal, "edit-body", state.metadata, now);
            if (state.metadata.headRevision !== expectedRevision) {
              return yield* Effect.fail(
                new DomainError({
                  code: "revision_conflict",
                  message: `Expected revision ${expectedRevision}, current revision is ${state.metadata.headRevision}.`,
                }),
              );
            }
            const update = yield* updateForReplacement(state.collaborative, body);
            const comments = yield* reanchorComments(
              state.collaborative,
              update,
              state.comments,
              now,
            );
            return yield* commitBodyUpdateUnlocked(
              update,
              `replace-${expectedRevision}-${now}`,
              now,
              comments,
            );
          }),
        ),
      reply: (principal, threadId, messageId, parentId, body, actor, now) =>
        updateComments(principal, now, (comments) =>
          replyToCommentThread(comments, threadId, messageId, parentId, body, actor, now),
        ),
      setThreadResolution: (principal, threadId, resolved, now) =>
        updateComments(principal, now, (comments) =>
          setCommentThreadResolution(comments, threadId, resolved, now),
        ),
      snapshot,
      synchronize: (principal, stateVector, now) =>
        withLock(
          Effect.gen(function* () {
            yield* authorizeDocument(principal, "read-working", state.metadata, now);
            const current = yield* makeSnapshot(state);
            const missing = yield* encodeMissingState(state.collaborative.document, stateVector);
            return { ...current, stateUpdate: missing };
          }),
        ),
      unpublish: (principal, now) =>
        withLock(
          Effect.gen(function* () {
            yield* authorizeDocument(principal, "publish", state.metadata, now);
            const metadata = yield* markUnpublished(state.metadata, now);
            const entry = yield* persist("publication-event", metadata, state.comments, undefined);
            state = { ...state, dirty: true, metadata, sequence: entry.sequence };
            yield* PubSub.publish(pubsub, { metadata, type: "published" });
            return metadata;
          }),
        ),
      updateMetadata: (principal, patch, expectedRevision, now, confirm = false) =>
        withLock(
          Effect.gen(function* () {
            yield* authorizeDocument(principal, "edit-metadata", state.metadata, now);
            const metadata = yield* updateDocumentMetadata(
              state.metadata,
              patch,
              expectedRevision,
              now,
              confirm,
            );
            const entry = yield* persist("metadata-event", metadata, state.comments, undefined);
            state = { ...state, dirty: true, metadata, sequence: entry.sequence };
            yield* PubSub.publish(pubsub, { metadata, type: "metadata-changed" });
            return metadata;
          }),
        ),
      updateSharing: (principal, access, expectedRevision, now, expiresAt) =>
        withLock(
          Effect.gen(function* () {
            yield* authorizeDocument(principal, "manage-sharing", state.metadata, now);
            const metadata = yield* updateSharingPolicy(
              state.metadata,
              access,
              expectedRevision,
              now,
              expiresAt,
            );
            const entry = yield* persist("sharing-event", metadata, state.comments, undefined);
            state = { ...state, dirty: true, metadata, sequence: entry.sequence };
            yield* PubSub.publish(pubsub, { metadata, type: "sharing-changed" });
            return metadata;
          }),
        ),
    };

    return authority;
  });
}

export function loadDocumentRevision(
  options: MakeDocumentAuthorityOptions,
  revision: DocumentRevision,
): Effect.Effect<
  DocumentSnapshot,
  RecoveryError | StorageError | CollaborationError,
  typeof ObjectStore.Service | typeof Digest.Service
> {
  return Effect.gen(function* () {
    const objectStore = yield* ObjectStore;
    const digest = yield* Digest;
    const stored = yield* objectStore.get(revisionKey(options, revision));
    if (stored === undefined) {
      return yield* recoveryFailure("document_missing", "The published revision does not exist.");
    }
    const actualDigest = yield* digest.sha256(stored.bytes);
    if (actualDigest !== stored.digest) {
      return yield* recoveryFailure("checkpoint_corrupt", "The revision digest does not match.");
    }
    const checkpoint = yield* decodeCheckpoint(stored.bytes);
    if (
      checkpoint.documentId !== options.documentId ||
      checkpoint.workspaceId !== options.workspaceId
    ) {
      return yield* recoveryFailure(
        "checkpoint_incompatible",
        "The revision belongs to another document.",
      );
    }
    const collaborative = yield* createCollaborativeDocument();
    const update = yield* decodeBase64(checkpoint.bodyUpdate).pipe(
      Effect.mapError(
        (error) => new RecoveryError({ code: "checkpoint_corrupt", message: error.message }),
      ),
    );
    yield* applyDocumentUpdate(collaborative.document, update);
    const state: MutableState = {
      checkpointSequence: checkpoint.sequence,
      collaborative,
      comments: checkpoint.comments as CommentState,
      dirty: false,
      metadata: checkpoint.metadata as DocumentMetadata,
      sequence: checkpoint.sequence,
    };
    const snapshot = yield* makeSnapshot(state);
    yield* destroyCollaborativeDocument(collaborative);
    return snapshot;
  });
}

function recoverState(
  options: MakeDocumentAuthorityOptions,
  objectStore: typeof ObjectStore.Service,
  journal: typeof DurableDocumentJournal.Service,
  digest: typeof Digest.Service,
): Effect.Effect<MutableState, RecoveryError | StorageError | CollaborationError> {
  return Effect.gen(function* () {
    const stored = yield* objectStore.get(headKey(options));
    const collaborative = yield* createCollaborativeDocument();
    let metadata: DocumentMetadata;
    let comments: CommentState;
    let sequence = 0;

    if (stored === undefined) {
      if (options.initialMetadata === undefined) {
        return yield* Effect.fail(
          new RecoveryError({
            code: "document_missing",
            message: "The document has no checkpoint.",
          }),
        );
      }
      metadata = options.initialMetadata;
      comments = emptyCommentState();
      if (options.initialBody !== undefined && options.initialBody.length > 0) {
        yield* replaceDocumentBody(collaborative, options.initialBody);
      }
    } else {
      const actualDigest = yield* digest.sha256(stored.bytes);
      if (actualDigest !== stored.digest) {
        return yield* recoveryFailure(
          "checkpoint_corrupt",
          "The document checkpoint digest does not match.",
        );
      }
      const checkpoint = yield* decodeCheckpoint(stored.bytes);
      if (
        checkpoint.workspaceId !== options.workspaceId ||
        checkpoint.documentId !== options.documentId
      ) {
        return yield* recoveryFailure(
          "checkpoint_incompatible",
          "The checkpoint belongs to another workspace or document.",
        );
      }
      metadata = checkpoint.metadata as DocumentMetadata;
      comments = checkpoint.comments as CommentState;
      sequence = checkpoint.sequence;
      const update = yield* decodeBase64(checkpoint.bodyUpdate).pipe(
        Effect.mapError(
          (error) => new RecoveryError({ code: "checkpoint_corrupt", message: error.message }),
        ),
      );
      yield* applyDocumentUpdate(collaborative.document, update);
    }

    const checkpointSequence = sequence;
    const entries = yield* journal.entriesAfter(options.documentId, sequence);
    for (const entry of entries.toSorted((left, right) => left.sequence - right.sequence)) {
      const wire = yield* decodeJournalWire(entry.payload);
      metadata = wire.metadata as DocumentMetadata;
      comments = (wire.comments ?? comments) as CommentState;
      if (wire.bodyUpdate !== undefined) {
        const update = yield* decodeBase64(wire.bodyUpdate).pipe(
          Effect.mapError(
            (error) => new RecoveryError({ code: "checkpoint_corrupt", message: error.message }),
          ),
        );
        yield* applyDocumentUpdate(collaborative.document, update);
      }
      sequence = entry.sequence;
    }

    return {
      checkpointSequence,
      collaborative,
      comments,
      dirty: entries.length > 0 || stored === undefined,
      metadata,
      sequence,
    };
  });
}

function checkpointState(
  options: MakeDocumentAuthorityOptions,
  getState: () => MutableState,
  setState: (state: MutableState) => void,
  mutex: Effect.Semaphore,
  objectStore: typeof ObjectStore.Service,
  journal: typeof DurableDocumentJournal.Service,
  digest: typeof Digest.Service,
  now: string,
): Effect.Effect<void, AuthorityError> {
  return Effect.gen(function* () {
    const capture = yield* mutex.withPermits(1)(
      Effect.gen(function* () {
        const current = getState();
        if (!current.dirty) {
          return undefined;
        }
        return yield* captureCheckpoint(options, current, now);
      }),
    );
    if (capture === undefined) {
      return;
    }
    const bytes = encodeCheckpoint(capture);
    const objectDigest = yield* digest.sha256(bytes);
    yield* objectStore.put(headKey(options), bytes, {
      digest: objectDigest,
      mediaType: "application/json",
    });
    yield* journal.truncateThrough(options.documentId, capture.sequence);
    yield* mutex.withPermits(1)(
      Effect.sync(() => {
        const current = getState();
        setState({
          ...current,
          checkpointSequence: Math.max(current.checkpointSequence, capture.sequence),
          dirty: current.sequence > capture.sequence,
        });
      }),
    );
    yield* writePortableProjections(options, capture, objectStore, digest).pipe(Effect.ignore);
  });
}

function captureCheckpoint(
  options: MakeDocumentAuthorityOptions,
  state: MutableState,
  now: string,
): Effect.Effect<CheckpointWire> {
  return encodeDocumentState(state.collaborative.document).pipe(
    Effect.map((bodyUpdate) => ({
      body: state.collaborative.body.toString(),
      bodyUpdate: encodeBase64(bodyUpdate),
      capturedAt: now,
      comments: state.comments,
      documentId: options.documentId,
      metadata: state.metadata,
      schemaVersion: 1 as const,
      sequence: state.sequence,
      workspaceId: options.workspaceId,
    })),
  );
}

function writePortableProjections(
  options: MakeDocumentAuthorityOptions,
  capture: CheckpointWire,
  objectStore: typeof ObjectStore.Service,
  digest: typeof Digest.Service,
): Effect.Effect<void, StorageError> {
  return Effect.gen(function* () {
    const body = capture.body ?? "";
    const metadata = JSON.stringify(capture.metadata, undefined, 2);
    const markdownBytes = textEncoder.encode(
      `---\njot: ${JSON.stringify(capture.metadata)}\n---\n\n${body}`,
    );
    const metadataBytes = textEncoder.encode(metadata);
    const markdownDigest = yield* digest.sha256(markdownBytes);
    const metadataDigest = yield* digest.sha256(metadataBytes);
    const prefix = `workspaces/${options.workspaceId}/documents/${options.documentId}/exports`;
    yield* Effect.all(
      [
        objectStore.put(`${prefix}/document.md`, markdownBytes, {
          digest: markdownDigest,
          mediaType: "text/markdown; charset=utf-8",
        }),
        objectStore.put(`${prefix}/metadata.json`, metadataBytes, {
          digest: metadataDigest,
          mediaType: "application/json",
        }),
      ],
      { concurrency: 2, discard: true },
    );
  });
}

function makeSnapshot(state: MutableState): Effect.Effect<DocumentSnapshot> {
  return Effect.all({
    stateUpdate: encodeDocumentState(state.collaborative.document),
    stateVector: encodeStateVector(state.collaborative.document),
  }).pipe(
    Effect.map(({ stateUpdate, stateVector }) => ({
      body: state.collaborative.body.toString(),
      comments: state.comments,
      metadata: state.metadata,
      sequence: state.sequence,
      stateUpdate,
      stateVector,
    })),
  );
}

function updateForReplacement(
  collaborative: CollaborativeDocument,
  replacement: string,
): Effect.Effect<Uint8Array, CollaborationError> {
  return Effect.gen(function* () {
    const clonedDocument = yield* cloneDocument(collaborative.document);
    const cloned: CollaborativeDocument = {
      body: clonedDocument.getText("body"),
      document: clonedDocument,
    };
    const vector = yield* encodeStateVector(collaborative.document);
    yield* replaceDocumentBody(cloned, replacement);
    const update = yield* encodeMissingState(cloned.document, vector);
    cloned.document.destroy();
    return update;
  });
}

function reanchorComments(
  collaborative: CollaborativeDocument,
  update: Uint8Array,
  comments: CommentState,
  now: string,
): Effect.Effect<CommentState, CollaborationError | DomainError> {
  return Effect.gen(function* () {
    const clonedDocument = yield* cloneDocument(collaborative.document);
    yield* applyDocumentUpdate(clonedDocument, update);
    const body = clonedDocument.getText("body");
    let updated = comments;
    for (const thread of comments.threads) {
      const anchor = yield* reanchorAfterReplacement(body, thread.anchor);
      updated = yield* replaceCommentAnchor(updated, thread.id, anchor, now);
    }
    clonedDocument.destroy();
    return updated;
  });
}

function encodeCheckpoint(checkpoint: CheckpointWire): Uint8Array {
  return textEncoder.encode(JSON.stringify(checkpoint));
}

function decodeCheckpoint(bytes: Uint8Array): Effect.Effect<CheckpointWire, RecoveryError> {
  return Schema.decodeUnknown(Schema.parseJson(checkpointWireSchema))(
    textDecoder.decode(bytes),
  ).pipe(
    Effect.mapError(
      (cause) =>
        new RecoveryError({
          cause,
          code: "checkpoint_corrupt",
          message: "The document checkpoint is not valid JSON state.",
        }),
    ),
  );
}

function encodeJournalWire(
  metadata: DocumentMetadata,
  comments: CommentState,
  bodyUpdate: Uint8Array | undefined,
): Uint8Array {
  return textEncoder.encode(
    JSON.stringify({
      ...(bodyUpdate === undefined ? {} : { bodyUpdate: encodeBase64(bodyUpdate) }),
      comments,
      metadata,
    }),
  );
}

function decodeJournalWire(
  bytes: Uint8Array,
): Effect.Effect<typeof journalWireSchema.Type, RecoveryError> {
  return Schema.decodeUnknown(Schema.parseJson(journalWireSchema))(textDecoder.decode(bytes)).pipe(
    Effect.mapError(
      (cause) =>
        new RecoveryError({
          cause,
          code: "checkpoint_corrupt",
          message: "A durable journal record is invalid.",
        }),
    ),
  );
}

function headKey(options: MakeDocumentAuthorityOptions): string {
  return `workspaces/${options.workspaceId}/documents/${options.documentId}/head.json`;
}

function revisionKey(options: MakeDocumentAuthorityOptions, revision: DocumentRevision): string {
  return `workspaces/${options.workspaceId}/documents/${options.documentId}/revisions/${revision}.json`;
}

function collaborationFailure(
  code: CollaborationError["code"],
  message: string,
): Effect.Effect<never, CollaborationError> {
  return Effect.fail(new CollaborationError({ code, message }));
}

function recoveryFailure(
  code: RecoveryError["code"],
  message: string,
): Effect.Effect<never, RecoveryError> {
  return Effect.fail(new RecoveryError({ code, message }));
}
