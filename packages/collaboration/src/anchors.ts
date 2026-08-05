import { Effect } from "effect";
import * as Y from "yjs";

import type { CommentAnchor } from "@earendil-works/jot-core";

import { decodeBase64, encodeBase64 } from "./binary.ts";
import { CollaborationError } from "./document.ts";

export interface ResolvedAnchor {
  readonly start: number;
  readonly end: number;
  readonly orphaned: boolean;
}

export function createCommentAnchor(
  body: Y.Text,
  start: number,
  end: number,
): Effect.Effect<CommentAnchor, CollaborationError> {
  if (start < 0 || end < start || end > body.length) {
    return anchorFailure("The selected comment range is invalid.");
  }
  return Effect.sync(() => {
    const text = body.toString();
    const relativeStart = Y.createRelativePositionFromTypeIndex(body, start);
    // Keep insertions made exactly after the selected text outside the anchor.
    const relativeEnd = Y.createRelativePositionFromTypeIndex(body, end, -1);
    return {
      end: encodeBase64(Y.encodeRelativePosition(relativeEnd)),
      orphaned: false,
      originalEnd: end,
      originalStart: start,
      prefix: text.slice(Math.max(0, start - 120), start),
      quote: text.slice(start, end),
      start: encodeBase64(Y.encodeRelativePosition(relativeStart)),
      suffix: text.slice(end, Math.min(text.length, end + 120)),
    };
  });
}

export function resolveCommentAnchor(
  document: Y.Doc,
  body: Y.Text,
  anchor: CommentAnchor,
): Effect.Effect<ResolvedAnchor, CollaborationError> {
  return Effect.gen(function* () {
    const encodedStart = yield* decodeBase64(anchor.start).pipe(
      Effect.mapError(
        (error) => new CollaborationError({ code: "invalid_anchor", message: error.message }),
      ),
    );
    const encodedEnd = yield* decodeBase64(anchor.end).pipe(
      Effect.mapError(
        (error) => new CollaborationError({ code: "invalid_anchor", message: error.message }),
      ),
    );
    const positions = yield* Effect.try({
      catch: (cause) =>
        new CollaborationError({
          code: "invalid_anchor",
          message: "The relative comment position is invalid.",
          cause,
        }),
      try: () => ({
        end: Y.createAbsolutePositionFromRelativePosition(
          Y.decodeRelativePosition(encodedEnd),
          document,
        ),
        start: Y.createAbsolutePositionFromRelativePosition(
          Y.decodeRelativePosition(encodedStart),
          document,
        ),
      }),
    });

    if (
      positions.start === null ||
      positions.end === null ||
      positions.start.type !== body ||
      positions.end.type !== body ||
      positions.end.index < positions.start.index
    ) {
      return { end: anchor.originalEnd, orphaned: true, start: anchor.originalStart };
    }
    const resolvedStart = positions.start.index;
    const resolvedEnd = positions.end.index;
    const selectedTextWasDeleted =
      anchor.originalEnd > anchor.originalStart && resolvedStart === resolvedEnd;
    return {
      end: resolvedEnd,
      orphaned: anchor.orphaned || selectedTextWasDeleted,
      start: resolvedStart,
    };
  });
}

export function reanchorAfterReplacement(
  body: Y.Text,
  anchor: CommentAnchor,
): Effect.Effect<CommentAnchor, CollaborationError> {
  const text = body.toString();
  const matches = findMatches(text, anchor.quote);
  if (matches.length === 0) {
    return Effect.succeed({ ...anchor, orphaned: true });
  }

  const contextualMatches = matches.filter((start) => {
    const prefix = text.slice(Math.max(0, start - anchor.prefix.length), start);
    const end = start + anchor.quote.length;
    const suffix = text.slice(end, end + anchor.suffix.length);
    return prefix.endsWith(anchor.prefix) && suffix.startsWith(anchor.suffix);
  });
  const candidates = contextualMatches.length === 1 ? contextualMatches : matches;
  if (candidates.length !== 1) {
    return Effect.succeed({ ...anchor, orphaned: true });
  }
  const start = candidates[0];
  if (start === undefined) {
    return Effect.succeed({ ...anchor, orphaned: true });
  }
  return createCommentAnchor(body, start, start + anchor.quote.length);
}

function findMatches(body: string, quote: string): readonly number[] {
  if (quote.length === 0) {
    return [];
  }
  const matches: number[] = [];
  let offset = 0;
  while (offset <= body.length - quote.length) {
    const found = body.indexOf(quote, offset);
    if (found === -1) {
      break;
    }
    matches.push(found);
    offset = found + Math.max(1, quote.length);
  }
  return matches;
}

function anchorFailure(message: string): Effect.Effect<never, CollaborationError> {
  return Effect.fail(new CollaborationError({ code: "invalid_anchor", message }));
}
