import { Data, Effect, Schema } from "effect";
import YAML from "yaml";

import { personId } from "@earendil-works/jot-core";
import type {
  CapabilityAccess,
  CreateMetadataInput,
  PersonReference,
  Sensitivity,
  Visibility,
} from "@earendil-works/jot-core";

export interface ImportedAttachment {
  readonly sourcePath: string;
  readonly markdownPath: string;
  readonly mediaType?: string | undefined;
}

export interface ImportedCommentMessage {
  readonly legacyId?: string | undefined;
  readonly parentLegacyId?: string | undefined;
  readonly author: string;
  readonly body: string;
  readonly createdAt?: string | undefined;
  readonly updatedAt?: string | undefined;
}

export interface ImportedCommentThread {
  readonly legacyId?: string | undefined;
  readonly quote: string;
  readonly prefix: string;
  readonly suffix: string;
  readonly originalStart?: number | undefined;
  readonly originalEnd?: number | undefined;
  readonly resolved: boolean;
  readonly messages: readonly ImportedCommentMessage[];
}

export interface ImportedMetadataInput extends Omit<CreateMetadataInput, "id"> {
  readonly id?: string | undefined;
  readonly updatedAt?: string | undefined;
}

export interface ImportedDocument {
  readonly metadata: ImportedMetadataInput;
  readonly body: string;
  readonly people: readonly PeopleDirectoryRecord[];
  readonly attachments: readonly ImportedAttachment[];
  readonly comments: readonly ImportedCommentThread[];
  readonly capabilityId?: string | undefined;
  readonly capabilityAccess?: CapabilityAccess | undefined;
  readonly relatedRfcNumbers: readonly number[];
  readonly warnings: readonly string[];
}

export interface PeopleDirectoryRecord {
  readonly displayName: string;
  readonly email: string;
  readonly aliases?: readonly string[] | undefined;
}

export interface ImportContext {
  readonly sourcePath: string;
  readonly people?: readonly PeopleDirectoryRecord[] | undefined;
  readonly attachments?: readonly ImportedAttachment[] | undefined;
  readonly now?: string | undefined;
}

export class ImportError extends Data.TaggedError("ImportError")<{
  readonly code: "invalid_frontmatter" | "invalid_metadata" | "invalid_sidecar";
  readonly message: string;
  readonly sourcePath: string;
  readonly cause?: unknown;
}> {}

const jotSidecarSchema = Schema.Struct({
  comments: Schema.optional(Schema.Array(Schema.Unknown)),
  createdAt: Schema.optional(Schema.String),
  id: Schema.String,
  shareAccess: Schema.optional(Schema.Literal("disabled", "view", "comment", "edit")),
  shareId: Schema.optional(Schema.String),
  title: Schema.String,
  updatedAt: Schema.optional(Schema.String),
});

export function importEarendilRfc(
  markdown: string,
  context: ImportContext,
): Effect.Effect<ImportedDocument, ImportError> {
  return Effect.gen(function* () {
    const parsed = yield* parseFrontmatter(markdown, context.sourcePath);
    const frontmatter = parsed.frontmatter;
    const warnings: string[] = [];
    const title = firstString(frontmatter, ["title", "name"]) ?? firstHeading(parsed.body);
    if (title === undefined) {
      return yield* importFailure(
        "invalid_metadata",
        "The RFC has neither a title field nor a top-level heading.",
        context.sourcePath,
      );
    }
    const number = parsePositiveInteger(
      firstValue(frontmatter, ["rfc", "rfc_number", "number"]) ??
        numberFromPath(context.sourcePath),
    );
    if (number === undefined) {
      warnings.push("RFC number was not found and must be allocated during import.");
    }
    const people = context.people ?? [];
    const authors = yield* normalizePeople(firstValue(frontmatter, ["authors", "author"]), people);
    const reviewers = yield* normalizePeople(
      firstValue(frontmatter, ["reviewers", "reviewer"]),
      people,
    );
    const approvers = yield* normalizePeople(
      firstValue(frontmatter, ["approvers", "approver"]),
      people,
    );
    const rawVisibility = firstString(frontmatter, ["visibility", "access"]);
    const visibility: Visibility =
      rawVisibility?.toLocaleLowerCase("en") === "public" ? "public" : "workspace";
    if (
      rawVisibility !== undefined &&
      !["public", "workspace", "internal", "private"].includes(
        rawVisibility.toLocaleLowerCase("en"),
      )
    ) {
      warnings.push(`Unknown visibility ${rawVisibility} was imported as workspace-only.`);
    }
    const sensitivity: Sensitivity = parseConfidential(frontmatter) ? "confidential" : "normal";
    const createdAt = normalizeDate(firstString(frontmatter, ["created", "created_at", "date"]));
    const updatedAt = normalizeDate(
      firstString(frontmatter, ["updated", "updated_at", "last_modified"]),
    );
    const lifecycleState = firstString(frontmatter, ["state", "status"]) ?? "draft";
    const labels = stringList(firstValue(frontmatter, ["labels", "keywords", "tags"]));
    const relatedRfcNumbers = stringList(
      firstValue(frontmatter, ["related", "related_rfcs", "related_documents"]),
    ).flatMap((value) => {
      const parsedNumber = parsePositiveInteger(value.replace(/^rfc\s*/iu, ""));
      return parsedNumber === undefined ? [] : [parsedNumber];
    });
    const legacySourceUrl = firstString(frontmatter, ["source", "source_url", "legacy_url"]);
    const targetDecisionDate = normalizeDate(
      firstString(frontmatter, ["target_decision_date", "decision_date"]),
    );
    const body = rewriteLegacyRfcLinks(removeMatchingTitleHeading(parsed.body, title));
    const metadata: ImportedMetadataInput = {
      approvers,
      authors,
      createdAt: createdAt ?? updatedAt ?? context.now,
      labels,
      legacySourceUrl,
      lifecycleState,
      reviewers,
      rfcNumber: number,
      sensitivity,
      targetDecisionDate,
      title,
      updatedAt: updatedAt ?? createdAt ?? context.now,
      visibility,
    };
    return {
      attachments: context.attachments ?? [],
      body,
      comments: [],
      metadata,
      people,
      relatedRfcNumbers,
      warnings,
    };
  });
}

export function importExistingJot(
  markdown: string,
  sidecar: unknown,
  context: ImportContext,
): Effect.Effect<ImportedDocument, ImportError> {
  return Effect.gen(function* () {
    const decoded = yield* Schema.decodeUnknown(jotSidecarSchema)(sidecar).pipe(
      Effect.mapError(
        (cause) =>
          new ImportError({
            cause,
            code: "invalid_sidecar",
            message: "The existing Jot metadata sidecar is invalid.",
            sourcePath: context.sourcePath,
          }),
      ),
    );
    const comments = decodeLegacyComments(decoded.comments ?? [], context.sourcePath);
    return {
      attachments: context.attachments ?? [],
      body: (yield* parseFrontmatter(markdown, context.sourcePath)).body,
      capabilityAccess: decoded.shareAccess,
      capabilityId: decoded.shareId,
      comments,
      metadata: {
        createdAt: normalizeDate(decoded.createdAt) ?? context.now,
        id: decoded.id,
        title: decoded.title,
        updatedAt: normalizeDate(decoded.updatedAt) ?? context.now,
      },
      people: context.people ?? [],
      relatedRfcNumbers: [],
      warnings: [],
    };
  });
}

export function rewriteLegacyRfcLinks(markdown: string): string {
  return markdown.replace(
    /\((?:\.\.\/|\.\/)?(?:rfcs?\/)?(?:rfc[-_ ]?)?(\d+)(?:-[^)#]*)?\.md(#[^)]+)?\)/giu,
    (_match, rfcDigits: string, fragment: string | undefined) =>
      `(/rfc/${String(Number(rfcDigits)).padStart(4, "0")}${fragment ?? ""})`,
  );
}

function parseFrontmatter(
  markdown: string,
  sourcePath: string,
): Effect.Effect<
  { readonly body: string; readonly frontmatter: Readonly<Record<string, unknown>> },
  ImportError
> {
  if (!markdown.startsWith("---\n") && !markdown.startsWith("---\r\n")) {
    return Effect.succeed({ body: markdown, frontmatter: {} });
  }
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(markdown);
  if (match?.[1] === undefined) {
    return importFailure(
      "invalid_frontmatter",
      "The Markdown frontmatter is not terminated.",
      sourcePath,
    );
  }
  const yamlSource = match[1];
  return Effect.try({
    catch: (cause) =>
      new ImportError({
        cause,
        code: "invalid_frontmatter",
        message: "The Markdown frontmatter is not valid YAML.",
        sourcePath,
      }),
    try: () => YAML.parse(yamlSource) as unknown,
  }).pipe(
    Effect.flatMap((value) =>
      isRecord(value)
        ? Effect.succeed({ body: markdown.slice(match[0].length), frontmatter: value })
        : importFailure(
            "invalid_frontmatter",
            "The Markdown frontmatter must be a YAML mapping.",
            sourcePath,
          ),
    ),
  );
}

function normalizePeople(
  input: unknown,
  directory: readonly PeopleDirectoryRecord[],
): Effect.Effect<readonly PersonReference[], ImportError> {
  return Effect.forEach(stringList(input), (raw) => {
    const normalized = raw.toLocaleLowerCase("en").trim();
    const known = directory.find(
      (person) =>
        person.displayName.toLocaleLowerCase("en") === normalized ||
        person.email.toLocaleLowerCase("en") === normalized ||
        person.aliases?.some((alias) => alias.toLocaleLowerCase("en") === normalized) === true,
    );
    const displayName = known?.displayName ?? raw.trim();
    const email = known?.email ?? (raw.includes("@") ? raw.trim() : `${slug(raw)}@import.invalid`);
    return personId(email.toLocaleLowerCase("en")).pipe(
      Effect.map((id) => ({ displayName, email, id })),
      Effect.mapError(
        (cause) =>
          new ImportError({
            cause,
            code: "invalid_metadata",
            message: `Imported person ${raw} has no stable identity.`,
            sourcePath: "people-directory",
          }),
      ),
    );
  });
}

function decodeLegacyComments(
  values: readonly unknown[],
  sourcePath: string,
): readonly ImportedCommentThread[] {
  return values.flatMap((value) => {
    if (!isRecord(value) || typeof value["quote"] !== "string") {
      return [];
    }
    const messages = Array.isArray(value["messages"])
      ? value["messages"].flatMap((message): ImportedCommentMessage[] => {
          if (!isRecord(message) || typeof message["body"] !== "string") return [];
          return [
            {
              author: typeof message["author"] === "string" ? message["author"] : "Imported user",
              body: message["body"],
              createdAt: stringValue(message["createdAt"]),
              legacyId: stringValue(message["id"]),
              parentLegacyId: stringValue(message["parentId"]),
              updatedAt: stringValue(message["updatedAt"]),
            },
          ];
        })
      : [];
    if (messages.length === 0) {
      void sourcePath;
    }
    return [
      {
        legacyId: stringValue(value["id"]),
        messages,
        originalEnd: numberValue(value["end"]),
        originalStart: numberValue(value["start"]),
        prefix: stringValue(value["prefix"]) ?? "",
        quote: value["quote"],
        resolved: value["resolved"] === true,
        suffix: stringValue(value["suffix"]) ?? "",
      },
    ];
  });
}

function firstHeading(markdown: string): string | undefined {
  return /^#\s+(.+)$/mu.exec(markdown)?.[1]?.trim();
}

function removeMatchingTitleHeading(markdown: string, title: string): string {
  const match = /^#\s+(.+)\r?\n?/mu.exec(markdown);
  return match?.[1]?.trim() === title ? markdown.replace(match[0], "").trimStart() : markdown;
}

function numberFromPath(sourcePath: string): number | undefined {
  return parsePositiveInteger(/(?:^|\D)(\d{1,8})(?:\D|$)/u.exec(sourcePath)?.[1]);
}

function firstString(
  record: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): string | undefined {
  return stringValue(firstValue(record, keys));
}

function firstValue(record: Readonly<Record<string, unknown>>, keys: readonly string[]): unknown {
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function stringList(value: unknown): readonly string[] {
  if (Array.isArray(value)) return value.flatMap((item) => stringList(item));
  if (typeof value !== "string" && typeof value !== "number") return [];
  return String(value)
    .split(/[,;]\s*/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parsePositiveInteger(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : Number(stringValue(value));
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

function normalizeDate(value: string | undefined): string | undefined {
  if (value === undefined || !Number.isFinite(Date.parse(value))) return undefined;
  return new Date(value).toISOString();
}

function parseConfidential(frontmatter: Readonly<Record<string, unknown>>): boolean {
  const value = firstValue(frontmatter, ["confidential", "sensitivity"]);
  return (
    value === true ||
    (typeof value === "string" && value.toLocaleLowerCase("en") === "confidential")
  );
}

function slug(value: string): string {
  return (
    value
      .normalize("NFKD")
      .toLocaleLowerCase("en")
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-|-$/gu, "") || "unknown"
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function importFailure(
  code: ImportError["code"],
  message: string,
  sourcePath: string,
): Effect.Effect<never, ImportError> {
  return Effect.fail(new ImportError({ code, message, sourcePath }));
}
