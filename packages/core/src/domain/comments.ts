import { Effect } from "effect";

import { DomainError } from "./document.ts";
import type { PersonId } from "./document.ts";

declare const opaqueThreadId: unique symbol;
declare const opaqueMessageId: unique symbol;

export type CommentThreadId = string & { readonly [opaqueThreadId]: true };
export type CommentMessageId = string & { readonly [opaqueMessageId]: true };

export interface CommentAnchor {
  /** Base64-encoded Yjs relative positions. */
  readonly start: string;
  readonly end: string;
  readonly quote: string;
  readonly prefix: string;
  readonly suffix: string;
  readonly originalStart: number;
  readonly originalEnd: number;
  readonly orphaned: boolean;
}

export interface CommentMessage {
  readonly id: CommentMessageId;
  readonly parentId?: CommentMessageId | undefined;
  readonly authorId: PersonId;
  readonly authorDisplayName: string;
  readonly body: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt?: string | undefined;
}

export interface CommentThread {
  readonly id: CommentThreadId;
  readonly anchor: CommentAnchor;
  readonly resolved: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly messages: readonly CommentMessage[];
}

export interface CommentState {
  readonly revision: number;
  readonly threads: readonly CommentThread[];
}

export interface CommentActor {
  readonly id: PersonId;
  readonly displayName: string;
  readonly manageAll: boolean;
}

export interface CreateThreadInput {
  readonly id: string;
  readonly messageId: string;
  readonly anchor: CommentAnchor;
  readonly body: string;
}

export function commentThreadId(value: string): Effect.Effect<CommentThreadId, DomainError> {
  return /^[A-Za-z0-9_-]{8,128}$/u.test(value)
    ? Effect.succeed(value as CommentThreadId)
    : fail("invalid_comment_thread_id", "Comment thread identifiers must be URL-safe.");
}

export function commentMessageId(value: string): Effect.Effect<CommentMessageId, DomainError> {
  return /^[A-Za-z0-9_-]{8,128}$/u.test(value)
    ? Effect.succeed(value as CommentMessageId)
    : fail("invalid_comment_message_id", "Comment message identifiers must be URL-safe.");
}

export function emptyCommentState(): CommentState {
  return { revision: 0, threads: [] };
}

export function createCommentThread(
  state: CommentState,
  input: CreateThreadInput,
  actor: CommentActor,
  now: string,
): Effect.Effect<CommentState, DomainError> {
  return Effect.gen(function* () {
    yield* validateAnchor(input.anchor);
    if (state.threads.some((thread) => thread.id === input.id)) {
      return yield* fail("duplicate_comment_thread", "The comment thread already exists.");
    }
    const id = yield* commentThreadId(input.id);
    const message = yield* createMessage(input.messageId, input.body, actor, now);
    const thread: CommentThread = {
      anchor: input.anchor,
      createdAt: now,
      id,
      messages: [message],
      resolved: false,
      updatedAt: now,
    };
    return { revision: state.revision + 1, threads: [...state.threads, thread] };
  });
}

export function replyToCommentThread(
  state: CommentState,
  threadId: string,
  messageId: string,
  parentId: string,
  body: string,
  actor: CommentActor,
  now: string,
): Effect.Effect<CommentState, DomainError> {
  return updateThread(state, threadId, (thread) =>
    Effect.gen(function* () {
      if (
        thread.messages.every(
          (message) => message.id !== parentId || message.deletedAt !== undefined,
        )
      ) {
        return yield* fail(
          "comment_parent_not_found",
          "The parent comment message does not exist.",
        );
      }
      if (thread.messages.some((message) => message.id === messageId)) {
        return yield* fail("duplicate_comment_message", "The comment message already exists.");
      }
      const message = yield* createMessage(messageId, body, actor, now);
      return {
        ...thread,
        messages: [...thread.messages, { ...message, parentId: yield* commentMessageId(parentId) }],
        updatedAt: now,
      };
    }),
  );
}

export function editCommentMessage(
  state: CommentState,
  threadId: string,
  messageId: string,
  body: string,
  actor: CommentActor,
  now: string,
): Effect.Effect<CommentState, DomainError> {
  return updateMessage(state, threadId, messageId, actor, (message) =>
    validateMessageBody(body).pipe(
      Effect.map((validatedBody) => ({ ...message, body: validatedBody, updatedAt: now })),
    ),
  );
}

export function deleteCommentMessage(
  state: CommentState,
  threadId: string,
  messageId: string,
  actor: CommentActor,
  now: string,
): Effect.Effect<CommentState, DomainError> {
  return updateMessage(state, threadId, messageId, actor, (message) =>
    Effect.succeed({ ...message, body: "", deletedAt: now, updatedAt: now }),
  );
}

export function setCommentThreadResolution(
  state: CommentState,
  threadId: string,
  resolved: boolean,
  now: string,
): Effect.Effect<CommentState, DomainError> {
  return updateThread(state, threadId, (thread) =>
    Effect.succeed({ ...thread, resolved, updatedAt: now }),
  );
}

export function deleteCommentThread(
  state: CommentState,
  threadId: string,
  actor: CommentActor,
): Effect.Effect<CommentState, DomainError> {
  if (!actor.manageAll) {
    return fail("comment_forbidden", "Only owners and administrators may delete threads.");
  }
  const threads = state.threads.filter((thread) => thread.id !== threadId);
  return threads.length === state.threads.length
    ? fail("comment_thread_not_found", "The comment thread does not exist.")
    : Effect.succeed({ revision: state.revision + 1, threads });
}

export function replaceCommentAnchor(
  state: CommentState,
  threadId: string,
  anchor: CommentAnchor,
  now: string,
): Effect.Effect<CommentState, DomainError> {
  return validateAnchor(anchor).pipe(
    Effect.flatMap(() =>
      updateThread(state, threadId, (thread) =>
        Effect.succeed({ ...thread, anchor, updatedAt: now }),
      ),
    ),
  );
}

function createMessage(
  id: string,
  body: string,
  actor: CommentActor,
  now: string,
): Effect.Effect<CommentMessage, DomainError> {
  return Effect.all({ body: validateMessageBody(body), id: commentMessageId(id) }).pipe(
    Effect.map(({ body: validatedBody, id: validatedId }) => ({
      authorDisplayName: actor.displayName,
      authorId: actor.id,
      body: validatedBody,
      createdAt: now,
      id: validatedId,
      updatedAt: now,
    })),
  );
}

function updateThread(
  state: CommentState,
  threadId: string,
  update: (thread: CommentThread) => Effect.Effect<CommentThread, DomainError>,
): Effect.Effect<CommentState, DomainError> {
  const index = state.threads.findIndex((thread) => thread.id === threadId);
  if (index === -1) {
    return fail("comment_thread_not_found", "The comment thread does not exist.");
  }
  const thread = state.threads[index];
  if (thread === undefined) {
    return fail("comment_thread_not_found", "The comment thread does not exist.");
  }
  return update(thread).pipe(
    Effect.map((updated) => ({
      revision: state.revision + 1,
      threads: state.threads.map((item, itemIndex) => (itemIndex === index ? updated : item)),
    })),
  );
}

function updateMessage(
  state: CommentState,
  threadId: string,
  messageId: string,
  actor: CommentActor,
  update: (message: CommentMessage) => Effect.Effect<CommentMessage, DomainError>,
): Effect.Effect<CommentState, DomainError> {
  return updateThread(state, threadId, (thread) => {
    const index = thread.messages.findIndex((message) => message.id === messageId);
    const message = thread.messages[index];
    if (index === -1 || message === undefined) {
      return fail("comment_message_not_found", "The comment message does not exist.");
    }
    if (!actor.manageAll && message.authorId !== actor.id) {
      return fail("comment_forbidden", "A comment may only be changed by its author.");
    }
    return update(message).pipe(
      Effect.map((updated) => ({
        ...thread,
        messages: thread.messages.map((item, itemIndex) => (itemIndex === index ? updated : item)),
      })),
    );
  });
}

function validateMessageBody(value: string): Effect.Effect<string, DomainError> {
  const body = value.trim();
  return body.length > 0 && body.length <= 20_000
    ? Effect.succeed(body)
    : fail(
        "invalid_comment_body",
        "Comment messages must contain between 1 and 20,000 characters.",
      );
}

function validateAnchor(anchor: CommentAnchor): Effect.Effect<void, DomainError> {
  return anchor.originalStart >= 0 &&
    anchor.originalEnd >= anchor.originalStart &&
    anchor.quote.length <= 20_000 &&
    anchor.prefix.length <= 500 &&
    anchor.suffix.length <= 500
    ? Effect.void
    : fail("invalid_comment_anchor", "The comment anchor is invalid.");
}

function fail<A = never>(code: string, message: string): Effect.Effect<A, DomainError> {
  return Effect.fail(new DomainError({ code, message }));
}
