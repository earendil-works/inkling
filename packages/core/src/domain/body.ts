import { Data, Effect } from "effect";

export interface TextReplacement {
  readonly oldText: string;
  readonly newText: string;
}

export interface LineRange {
  readonly start: number;
  readonly end: number;
}

export class BodyEditError extends Data.TaggedError("BodyEditError")<{
  readonly code: "ambiguous_text" | "invalid_range" | "missing_text" | "overlapping_edits";
  readonly message: string;
}> {}

export function applyUniqueTextReplacements(
  body: string,
  replacements: readonly TextReplacement[],
): Effect.Effect<string, BodyEditError> {
  return Effect.gen(function* () {
    const located: Array<{
      readonly start: number;
      readonly end: number;
      readonly newText: string;
    }> = [];

    for (const replacement of replacements) {
      if (replacement.oldText.length === 0) {
        return yield* editFailure("missing_text", "Replacement text may not be empty.");
      }
      const start = body.indexOf(replacement.oldText);
      if (start === -1) {
        return yield* editFailure(
          "missing_text",
          "Replacement text was not found in the current head.",
        );
      }
      if (body.indexOf(replacement.oldText, start + replacement.oldText.length) !== -1) {
        return yield* editFailure(
          "ambiguous_text",
          "Replacement text occurs more than once in the current head.",
        );
      }
      located.push({
        end: start + replacement.oldText.length,
        newText: replacement.newText,
        start,
      });
    }

    const ordered = located.toSorted((left, right) => left.start - right.start);
    for (let index = 1; index < ordered.length; index += 1) {
      const previous = ordered[index - 1];
      const current = ordered[index];
      if (previous !== undefined && current !== undefined && current.start < previous.end) {
        return yield* editFailure("overlapping_edits", "Replacement ranges may not overlap.");
      }
    }

    return ordered
      .toSorted((left, right) => right.start - left.start)
      .reduce(
        (currentBody, edit) =>
          `${currentBody.slice(0, edit.start)}${edit.newText}${currentBody.slice(edit.end)}`,
        body,
      );
  });
}

export function readLineRange(
  body: string,
  range?: LineRange,
): Effect.Effect<string, BodyEditError> {
  if (range === undefined) {
    return Effect.succeed(body);
  }
  if (
    !Number.isSafeInteger(range.start) ||
    !Number.isSafeInteger(range.end) ||
    range.start < 1 ||
    range.end < range.start
  ) {
    return editFailure("invalid_range", "Line ranges are one-based and inclusive.");
  }
  const lines = body.split("\n");
  if (range.start > lines.length) {
    return editFailure("invalid_range", "The requested line range begins after the document ends.");
  }
  return Effect.succeed(lines.slice(range.start - 1, range.end).join("\n"));
}

function editFailure(
  code: BodyEditError["code"],
  message: string,
): Effect.Effect<never, BodyEditError> {
  return Effect.fail(new BodyEditError({ code, message }));
}
