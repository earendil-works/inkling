import { Effect } from "effect";

import type {
  CommentThreadDto,
  DocumentHistoryVersionDto,
  DocumentMetadataDto,
  DocumentResponse,
  DocumentSummary,
  PersonDto,
  SearchPassageDto,
} from "@earendil-works/inkling-protocol";

import { canonicalRfcPath } from "../routes.ts";
import { formatRfcNumber, ToolInputError } from "./api.ts";

/**
 * Text renderings returned to the model. They are compact, stable, and keep
 * document content visibly delimited from Inkling's own framing so a model can
 * tell the two apart. The same data is returned as `structuredContent` for
 * hosts that consume JSON.
 */

export interface LineRange {
  readonly body: string;
  readonly end: number;
  readonly start: number;
  readonly total: number;
  readonly truncated: boolean;
}

export function sliceLines(
  body: string,
  start: number | undefined,
  end: number | undefined,
  options: { readonly maxLines: number },
): Effect.Effect<LineRange, ToolInputError> {
  const lines = body.split("\n");
  const total = lines.length;
  const first = start ?? 1;
  if (end !== undefined && end < first) {
    return Effect.fail(new ToolInputError({ message: "end_line must not precede start_line." }));
  }
  if (first > total) {
    return Effect.fail(
      new ToolInputError({
        message: `start_line ${first} is past the end of the document (${total} lines).`,
      }),
    );
  }
  const last = Math.min(total, end ?? first + options.maxLines - 1);
  return Effect.succeed({
    body:
      start === undefined && end === undefined && last === total
        ? body
        : lines.slice(first - 1, last).join("\n"),
    end: last,
    start: first,
    total,
    truncated: end === undefined && last < total,
  });
}

export function documentUrl(
  origin: string,
  metadata: Pick<DocumentMetadataDto, "id" | "rfcNumber">,
): string {
  return `${origin}${
    metadata.rfcNumber === undefined
      ? `/documents/${encodeURIComponent(metadata.id)}`
      : canonicalRfcPath(metadata.rfcNumber)
  }`;
}

export function renderDocument(
  origin: string,
  document: DocumentResponse,
  range: LineRange,
  view: string,
): string {
  const { metadata } = document;
  const lines = [
    `${metadata.rfcNumber === undefined ? "Note" : formatRfcNumber(metadata.rfcNumber)}: ${metadata.title}`,
    `ID: ${metadata.id}`,
    `Revision: ${metadata.headRevision} (${view})`,
    `State: ${metadata.lifecycleState}; ${
      metadata.personalOwner === undefined
        ? `visibility: ${metadata.visibility}`
        : metadata.sharedWith === undefined || metadata.sharedWith.length === 0
          ? `personal, owned by ${metadata.personalOwner}`
          : `personal, owned by ${metadata.personalOwner}, shared with ${metadata.sharedWith
              .map((person) => person.email)
              .join(", ")}`
    }; ${
      metadata.publishedRevision === undefined
        ? "unpublished"
        : `published revision ${metadata.publishedRevision}`
    }`,
    ...(metadata.labels.length === 0 ? [] : [`Labels: ${metadata.labels.join(", ")}`]),
    ...peopleLine("Authors", metadata.authors),
    ...peopleLine("Reviewers", metadata.reviewers),
    ...peopleLine("Approvers", metadata.approvers),
    ...(metadata.targetDecisionDate === undefined
      ? []
      : [`Target decision: ${metadata.targetDecisionDate}`]),
    ...(metadata.relatedDocuments.length === 0
      ? []
      : [
          `Related: ${metadata.relatedDocuments
            .map((related) =>
              related.relationship === undefined
                ? related.documentId
                : `${related.documentId} (${related.relationship})`,
            )
            .join(", ")}`,
        ]),
    `Updated: ${metadata.updatedAt}`,
    ...(metadata.deletedAt === undefined ? [] : [`Deleted: ${metadata.deletedAt} (in Trash)`]),
    `URL: ${documentUrl(origin, metadata)}`,
    range.start === 1 && range.end === range.total
      ? `Lines: ${range.total}`
      : `Lines: ${range.start}-${range.end} of ${range.total}${
          range.truncated ? ` (truncated; pass start_line=${range.end + 1} to continue)` : ""
        }`,
    "",
    "<document_body>",
    range.body,
    "</document_body>",
  ];
  const threads = document.comments.threads;
  if (threads.length > 0) {
    const open = threads.filter((thread) => !thread.resolved).length;
    lines.push(
      "",
      `Comments: ${open} open, ${threads.length - open} resolved`,
      "<comments>",
      renderComments(threads),
      "</comments>",
    );
  }
  return lines.join("\n");
}

export function renderComments(threads: readonly CommentThreadDto[]): string {
  return threads
    .map((thread) => {
      const state = [
        thread.resolved ? "resolved" : "open",
        ...(thread.anchor.orphaned ? ["orphaned: quoted text no longer exists"] : []),
      ].join(", ");
      const messages = thread.messages.map(
        (message) =>
          `  ${message.id}${message.parentId === undefined ? "" : ` (reply to ${message.parentId})`} ${message.authorDisplayName}, ${message.createdAt}: ${
            message.deletedAt === undefined ? indent(message.body) : "(deleted)"
          }`,
      );
      return [
        `Thread ${thread.id} [${state}] on "${quote(thread.anchor.quote)}"`,
        ...messages,
      ].join("\n");
    })
    .join("\n\n");
}

export function renderCatalog(
  documents: readonly DocumentSummary[],
  total: number,
  trash: boolean,
): string {
  const rows = documents.map(({ excerpt, metadata }) => {
    const folio = metadata.rfcNumber === undefined ? "Note" : formatRfcNumber(metadata.rfcNumber);
    const status = trash
      ? `deleted ${metadata.deletedAt ?? "unknown"}`
      : `${metadata.lifecycleState}, ${metadata.personalOwner === undefined ? metadata.visibility : "personal"}, ${
          metadata.publishedRevision === undefined ? "unpublished" : "published"
        }, updated ${metadata.updatedAt.slice(0, 10)}`;
    const summary = excerpt.replace(/\s+/gu, " ").trim();
    return `${folio} ${metadata.id} "${metadata.title}" (${status})${
      metadata.labels.length === 0 ? "" : ` [${metadata.labels.join(", ")}]`
    }${summary === "" ? "" : `\n  ${summary.length > 200 ? `${summary.slice(0, 199)}…` : summary}`}`;
  });
  return [
    ...rows,
    ...(total > documents.length
      ? [`\n${total - documents.length} more not shown; narrow the query or raise limit.`]
      : []),
  ].join("\n");
}

export function renderPassages(passages: readonly SearchPassageDto[]): string {
  return passages
    .map((passage, index) => {
      const folio = passage.rfcNumber === undefined ? "Note" : formatRfcNumber(passage.rfcNumber);
      const section =
        passage.headingPath.length === 0 ? "" : ` › ${passage.headingPath.join(" › ")}`;
      return [
        `${index + 1}. ${folio} ${passage.documentId} "${passage.title}"${section}`,
        `   Lines ${passage.startLine}-${passage.endLine} at revision ${passage.revision}; matched by ${passage.matchedBy.join(" and ")}`,
        `   <passage>${passage.snippet}</passage>`,
      ].join("\n");
    })
    .join("\n\n");
}

export function renderHistory(
  documentId: string,
  versions: readonly DocumentHistoryVersionDto[],
  total: number,
): string {
  if (versions.length === 0) return `${documentId} has no recorded history.`;
  const rows = versions.map((version) => {
    const actor =
      version.actor === undefined
        ? ""
        : ` by ${version.actor.displayName ?? version.actor.id ?? version.actor.kind}`;
    return `Revision ${version.revision}: ${version.kind}${actor}${
      version.occurredAt === undefined ? "" : ` at ${version.occurredAt}`
    }`;
  });
  return [
    ...rows,
    ...(total > versions.length ? [`${total - versions.length} older revisions not shown.`] : []),
  ].join("\n");
}

function peopleLine(label: string, people: readonly PersonDto[]): readonly string[] {
  return people.length === 0
    ? []
    : [`${label}: ${people.map((person) => `${person.displayName} <${person.email}>`).join(", ")}`];
}

function quote(value: string): string {
  const flattened = value.replace(/\s+/gu, " ").trim();
  return flattened.length > 120 ? `${flattened.slice(0, 119)}…` : flattened;
}

function indent(value: string): string {
  return value.replaceAll("\n", "\n    ");
}
