#!/usr/bin/env node

import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { Data, Effect, Either, Schema } from "effect";

import { importEarendilRfc, rewriteKnownRfcSourceLinks } from "../packages/importers/src/index.ts";
import type {
  ImportedAttachment,
  ImportedDocument,
  PeopleDirectoryRecord,
} from "../packages/importers/src/index.ts";
import { serializeDocumentFrontmatter } from "../packages/renderer/src/index.ts";
import { makeCliClient } from "../packages/cli/src/client.ts";
import type { CliClient } from "../packages/cli/src/client.ts";
import type {
  DocumentMetadataDto,
  DocumentResponse,
  ImportDocumentRequest,
} from "../packages/protocol/src/index.ts";

const defaultSourceDirectory = path.join(homedir(), "Development", "earendil-rfcs");

const peopleFileSchema = Schema.Record({
  key: Schema.String,
  value: Schema.Struct({
    aliases: Schema.optional(Schema.Array(Schema.String)),
    name: Schema.String,
  }),
});

interface CommandOptions {
  readonly apiKey: string | undefined;
  readonly baseUrl: string;
  readonly dryRun: boolean;
  readonly help: boolean;
  readonly publishAll: boolean;
  readonly sourceDirectory: string;
}

interface PreparedRfc {
  readonly imported: ImportedDocument;
  readonly number: number;
  readonly sourcePath: string;
}

interface DesiredMetadata {
  readonly approvers: DocumentMetadataDto["approvers"];
  readonly authors: DocumentMetadataDto["authors"];
  readonly labels: DocumentMetadataDto["labels"];
  readonly legacySourceUrl: string | undefined;
  readonly lifecycleState: string;
  readonly relatedDocuments: DocumentMetadataDto["relatedDocuments"];
  readonly reviewers: DocumentMetadataDto["reviewers"];
  readonly sensitivity: DocumentMetadataDto["sensitivity"];
  readonly targetDecisionDate: string | undefined;
  readonly visibility: DocumentMetadataDto["visibility"];
}

interface SyncResult {
  readonly attachmentUploads: number;
  readonly kind: "created" | "unchanged" | "updated";
  readonly published: boolean;
}

class ImportCommandError extends Data.TaggedError("ImportCommandError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  Effect.runPromise(run(process.argv.slice(2)).pipe(Effect.catchAll(reportFailure))).catch(
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}

function run(arguments_: readonly string[]): Effect.Effect<void, ImportCommandError> {
  return Effect.gen(function* () {
    const options = yield* parseOptions(arguments_);
    if (options.help) {
      printHelp();
      return;
    }

    const prepared = yield* prepareRfcs(options.sourceDirectory);
    const attachmentCount = prepared.reduce(
      (total, rfc) => total + rfc.imported.attachments.length,
      0,
    );
    const publicCount = prepared.filter(
      (rfc) => rfc.imported.metadata.visibility === "public",
    ).length;
    const publicationCount = options.publishAll ? prepared.length : publicCount;
    for (const rfc of prepared) {
      for (const warning of rfc.imported.warnings) {
        console.error(`warning: RFC ${formatRfcNumber(rfc.number)}: ${warning}`);
      }
    }

    if (options.dryRun) {
      console.log(
        `Validated ${prepared.length} RFCs and ${attachmentCount} attachments (${publicCount} public RFCs, ${publicationCount} marked for publication).`,
      );
      return;
    }
    if (options.apiKey === undefined || options.apiKey.trim() === "") {
      return yield* fail("INKLING_API_KEY or --api-key is required unless --dry-run is used.");
    }

    const client = makeCliClient({
      apiKey: options.apiKey,
      baseUrl: options.baseUrl,
      name: "earendil-rfc-import",
    });
    const catalog = yield* client.list("").pipe(Effect.mapError(importFailure));
    const existingByNumber = new Map<number, string>();
    for (const document of catalog.documents) {
      const number = document.metadata.rfcNumber;
      if (number === undefined) continue;
      if (existingByNumber.has(number)) {
        return yield* fail(
          `The Inkling catalog contains RFC ${formatRfcNumber(number)} more than once.`,
        );
      }
      existingByNumber.set(number, document.metadata.id);
    }

    const documentIds = new Map(
      prepared.map((rfc) => [
        rfc.number,
        existingByNumber.get(rfc.number) ?? importedDocumentId(rfc.number),
      ]),
    );
    let created = 0;
    let updated = 0;
    let unchanged = 0;
    let published = 0;
    let uploaded = 0;
    let failed = 0;

    for (const rfc of prepared) {
      const existing = existingByNumber.has(rfc.number);
      const outcome = yield* syncRfc(client, rfc, documentIds, existing, options.publishAll).pipe(
        Effect.either,
      );
      if (Either.isLeft(outcome)) {
        failed += 1;
        console.error(`failed RFC ${formatRfcNumber(rfc.number)}: ${errorMessage(outcome.left)}`);
        continue;
      }

      const result = outcome.right;
      if (result.kind === "created") created += 1;
      else if (result.kind === "updated") updated += 1;
      else unchanged += 1;
      if (result.published) published += 1;
      uploaded += result.attachmentUploads;
      console.log(`${result.kind.padEnd(9)} RFC ${formatRfcNumber(rfc.number)}`);
    }

    console.log(
      `RFC import complete: ${created} created, ${updated} updated, ${unchanged} unchanged, ${uploaded} attachments uploaded, ${published} publications updated.`,
    );
    if (failed > 0) {
      return yield* fail(`${failed} RFC${failed === 1 ? "" : "s"} failed to import.`);
    }
  });
}

function prepareRfcs(
  sourceDirectory: string,
): Effect.Effect<readonly PreparedRfc[], ImportCommandError> {
  return Effect.gen(function* () {
    const people = yield* loadPeople(path.join(sourceDirectory, "people.json"));
    const rfcDirectory = path.join(sourceDirectory, "rfcs");
    const entries = yield* fileOperation(`read ${rfcDirectory}`, () =>
      readdir(rfcDirectory, { withFileTypes: true }),
    );
    const filenames = entries
      .filter((entry) => entry.isFile() && /^\d{4,8}\.md$/u.test(entry.name))
      .map((entry) => entry.name)
      .toSorted();
    if (filenames.length === 0) {
      return yield* fail(`No numbered RFC Markdown files were found in ${rfcDirectory}.`);
    }

    const now = new Date().toISOString();
    const documents = yield* Effect.forEach(filenames, (filename) =>
      Effect.gen(function* () {
        const sourcePath = path.join(rfcDirectory, filename);
        const markdown = yield* fileOperation(`read ${sourcePath}`, () =>
          readFile(sourcePath, "utf8"),
        );
        const pathNumber = Number(path.basename(filename, ".md"));
        const attachments = yield* loadAttachments(rfcDirectory, pathNumber);
        const imported = yield* importEarendilRfc(markdown, {
          attachments,
          now,
          people,
          sourcePath,
        }).pipe(Effect.mapError(importFailure));
        const number = imported.metadata.rfcNumber;
        if (number === undefined) {
          return yield* fail(`${sourcePath} does not declare an RFC number.`);
        }
        if (number !== pathNumber) {
          return yield* fail(
            `${sourcePath} declares RFC ${number}, which does not match its filename.`,
          );
        }
        const missingAttachments = referencedMediaPaths(imported.body).filter(
          (markdownPath) =>
            !attachments.some((attachment) => attachment.markdownPath === markdownPath),
        );
        if (missingAttachments.length > 0) {
          return yield* fail(
            `${sourcePath} references missing media: ${missingAttachments.join(", ")}.`,
          );
        }
        return { imported, number, sourcePath } satisfies PreparedRfc;
      }),
    );

    const numbers = new Set<number>();
    for (const document of documents) {
      if (numbers.has(document.number)) {
        return yield* fail(`RFC ${formatRfcNumber(document.number)} occurs more than once.`);
      }
      numbers.add(document.number);
    }
    const knownSources = documents.map(({ imported }) => imported.metadata);
    return documents.map((document) => ({
      imported: {
        ...document.imported,
        body: rewriteKnownRfcSourceLinks(document.imported.body, knownSources),
      },
      number: document.number,
      sourcePath: document.sourcePath,
    }));
  });
}

function syncRfc(
  client: CliClient,
  rfc: PreparedRfc,
  documentIds: ReadonlyMap<number, string>,
  existing: boolean,
  publishAll: boolean,
): Effect.Effect<SyncResult, unknown> {
  return Effect.gen(function* () {
    const documentId = documentIds.get(rfc.number);
    if (documentId === undefined) {
      return yield* fail(`No target document ID was assigned to RFC ${rfc.number}.`);
    }
    const relatedDocuments = rfc.imported.relatedRfcNumbers.map((number) => ({
      documentId: documentIds.get(number) ?? importedDocumentId(number),
    }));
    const request: ImportDocumentRequest = {
      body: rfc.imported.body,
      comments: [],
      metadata: {
        ...rfc.imported.metadata,
        id: documentId,
        relatedDocuments,
      },
      people: rfc.imported.people,
      publish: false,
    };
    let current = existing ? yield* client.read(documentId) : yield* client.importDocument(request);

    const attachmentResult = yield* synchronizeAttachments(client, current, rfc.imported);
    const desiredMetadata = metadataFor(rfc.imported, relatedDocuments);
    let metadataChanged = false;
    if (!sameMetadata(current.metadata, desiredMetadata)) {
      const metadata = yield* client.metadata(documentId, {
        ...desiredMetadata,
        confirmConfidentialPublic:
          desiredMetadata.visibility === "public" && desiredMetadata.sensitivity === "confidential",
        expectedRevision: current.metadata.headRevision,
        legacySourceUrl: desiredMetadata.legacySourceUrl ?? null,
        targetDecisionDate: desiredMetadata.targetDecisionDate ?? null,
      });
      current = { ...current, metadata };
      metadataChanged = true;
    }

    const desiredBody = canonicalBody(rfc.imported, attachmentResult.urls);
    let bodyChanged = false;
    if (current.body !== desiredBody) {
      current = yield* client.replaceBody(documentId, desiredBody, current.metadata.headRevision);
      bodyChanged = true;
    }

    const shouldPublish = publishAll || desiredMetadata.visibility === "public";
    let publicationChanged = false;
    if (shouldPublish) {
      if (current.metadata.publishedRevision === undefined || metadataChanged || bodyChanged) {
        const metadata = yield* client.publish(
          documentId,
          desiredMetadata.sensitivity === "confidential" && desiredMetadata.visibility === "public",
        );
        current = { ...current, metadata };
        publicationChanged = true;
      }
    } else if (current.metadata.publishedRevision !== undefined) {
      const metadata = yield* client.unpublish(documentId);
      current = { ...current, metadata };
      publicationChanged = true;
    }

    const changed =
      metadataChanged || bodyChanged || publicationChanged || attachmentResult.uploaded > 0;
    return {
      attachmentUploads: attachmentResult.uploaded,
      kind: existing ? (changed ? "updated" : "unchanged") : "created",
      published: publicationChanged && shouldPublish,
    };
  });
}

function synchronizeAttachments(
  client: CliClient,
  document: DocumentResponse,
  imported: ImportedDocument,
): Effect.Effect<
  { readonly uploaded: number; readonly urls: ReadonlyMap<string, string> },
  unknown
> {
  return Effect.gen(function* () {
    const existing = yield* client.listAttachments(document.metadata.id);
    const urls = new Map<string, string>();
    let uploaded = 0;
    for (const attachment of imported.attachments) {
      const bytes = yield* fileOperation(`read ${attachment.sourcePath}`, () =>
        readFile(attachment.sourcePath),
      );
      const digest = createHash("sha256").update(bytes).digest("hex");
      let remote = existing.find((candidate) => candidate.digest === digest);
      if (remote === undefined) {
        remote = yield* client.uploadAttachment(
          document.metadata.id,
          path.basename(attachment.sourcePath),
          attachment.mediaType ?? mediaTypeFor(attachment.sourcePath),
          bytes,
        );
        uploaded += 1;
      }
      urls.set(attachment.markdownPath, remote.url);
    }
    return { uploaded, urls };
  });
}

function canonicalBody(
  imported: ImportedDocument,
  attachmentUrls: ReadonlyMap<string, string>,
): string {
  const metadata = imported.metadata;
  let body = imported.body;
  for (const [markdownPath, url] of attachmentUrls) {
    body = body.replaceAll(markdownPath, url);
  }
  const frontmatter = serializeDocumentFrontmatter({
    authors: (metadata.authors ?? []).map((author) => author.email.toLocaleLowerCase("en")),
    labels: normalizedLabels(metadata.labels ?? []),
    sensitivity: metadata.sensitivity ?? "normal",
    state: metadata.lifecycleState ?? "draft",
    visibility: metadata.visibility ?? "workspace",
  });
  return `${frontmatter}\n${body}`;
}

function metadataFor(
  imported: ImportedDocument,
  relatedDocuments: DocumentMetadataDto["relatedDocuments"],
): DesiredMetadata {
  const metadata = imported.metadata;
  return {
    approvers: [...(metadata.approvers ?? [])],
    authors: [...(metadata.authors ?? [])],
    labels: normalizedLabels(metadata.labels ?? []),
    legacySourceUrl: metadata.legacySourceUrl,
    lifecycleState: metadata.lifecycleState ?? "draft",
    relatedDocuments,
    reviewers: [...(metadata.reviewers ?? [])],
    sensitivity: metadata.sensitivity ?? "normal",
    targetDecisionDate: metadata.targetDecisionDate,
    visibility: metadata.visibility ?? "workspace",
  };
}

function sameMetadata(current: DocumentMetadataDto, desired: DesiredMetadata): boolean {
  return (
    JSON.stringify({
      approvers: current.approvers,
      authors: current.authors,
      labels: current.labels,
      legacySourceUrl: current.legacySourceUrl,
      lifecycleState: current.lifecycleState,
      relatedDocuments: current.relatedDocuments,
      reviewers: current.reviewers,
      sensitivity: current.sensitivity,
      targetDecisionDate: current.targetDecisionDate,
      visibility: current.visibility,
    }) === JSON.stringify(desired)
  );
}

function normalizedLabels(labels: readonly string[]): string[] {
  return [...new Set(labels.map((label) => label.trim()).filter(Boolean))].toSorted((left, right) =>
    left.localeCompare(right),
  );
}

function loadPeople(
  filename: string,
): Effect.Effect<readonly PeopleDirectoryRecord[], ImportCommandError> {
  return fileOperation(`read ${filename}`, () => readFile(filename, "utf8")).pipe(
    Effect.flatMap((source) =>
      Schema.decodeUnknown(Schema.parseJson(peopleFileSchema))(source).pipe(
        Effect.mapError((cause) => importFailure(cause, `${filename} is not a valid people file.`)),
      ),
    ),
    Effect.map((people) =>
      Object.entries(people).map(([email, record]) => ({
        aliases: record.aliases ?? [],
        displayName: record.name,
        email,
      })),
    ),
  );
}

function loadAttachments(
  rfcDirectory: string,
  number: number,
): Effect.Effect<readonly ImportedAttachment[], ImportCommandError> {
  const mediaDirectory = path.join(rfcDirectory, ".media", formatRfcNumber(number));
  return fileOperation(`read media under ${mediaDirectory}`, () => walkFiles(mediaDirectory)).pipe(
    Effect.map((files) =>
      files.map((sourcePath) => {
        const relative = path.relative(mediaDirectory, sourcePath).split(path.sep).join("/");
        return {
          markdownPath: `_img/${relative}`,
          mediaType: mediaTypeFor(sourcePath),
          sourcePath,
        };
      }),
    ),
  );
}

async function walkFiles(directory: string): Promise<readonly string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isMissingFileError(error)) return [];
    throw error;
  }
  const files = await Promise.all(
    entries.map((entry) => {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) return walkFiles(filename);
      return Promise.resolve(entry.isFile() ? [filename] : []);
    }),
  );
  return files.flat().toSorted();
}

function referencedMediaPaths(markdown: string): readonly string[] {
  return [
    ...new Set(
      [...markdown.matchAll(/(?:^|[<(\s])(_img\/[^\s)>"']+)/gmu)].flatMap((match) =>
        match[1] === undefined ? [] : [match[1]],
      ),
    ),
  ];
}

function mediaTypeFor(filename: string): string {
  switch (path.extname(filename).toLocaleLowerCase("en")) {
    case ".gif":
      return "image/gif";
    case ".jpeg":
    case ".jpg":
      return "image/jpeg";
    case ".pdf":
      return "application/pdf";
    case ".png":
      return "image/png";
    case ".svg":
      return "image/svg+xml";
    case ".txt":
      return "text/plain";
    case ".webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
}

function importedDocumentId(number: number): string {
  return `doc_earendil_rfc_${formatRfcNumber(number)}`;
}

function formatRfcNumber(number: number): string {
  return String(number).padStart(4, "0");
}

function parseOptions(
  arguments_: readonly string[],
): Effect.Effect<CommandOptions, ImportCommandError> {
  let apiKey = process.env["INKLING_API_KEY"];
  let baseUrl = process.env["INKLING_URL"] ?? "http://localhost:5173";
  let dryRun = false;
  let help = false;
  let publishAll = false;
  let sourceDirectory = defaultSourceDirectory;

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--dry-run") dryRun = true;
    else if (argument === "--help" || argument === "-h") help = true;
    else if (argument === "--publish") publishAll = true;
    else if (argument === "--api-key") {
      apiKey = arguments_[index + 1];
      index += 1;
      if (apiKey === undefined) return fail("--api-key requires a value.");
    } else if (argument === "--source") {
      const value = arguments_[index + 1];
      index += 1;
      if (value === undefined) return fail("--source requires a path.");
      sourceDirectory = value;
    } else if (argument === "--url") {
      const value = arguments_[index + 1];
      index += 1;
      if (value === undefined) return fail("--url requires a value.");
      baseUrl = value;
    } else {
      return fail(`Unknown argument: ${argument ?? ""}`);
    }
  }

  try {
    const parsedUrl = new URL(baseUrl);
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      return fail("--url must use HTTP or HTTPS.");
    }
    baseUrl = parsedUrl.href;
  } catch (cause) {
    return fail("--url must be a valid URL.", cause);
  }
  return Effect.succeed({
    apiKey,
    baseUrl,
    dryRun,
    help,
    publishAll,
    sourceDirectory: path.resolve(sourceDirectory),
  });
}

function fileOperation<A>(
  operation: string,
  attempt: () => Promise<A>,
): Effect.Effect<A, ImportCommandError> {
  return Effect.tryPromise({
    catch: (cause) => importFailure(cause, `Could not ${operation}.`),
    try: attempt,
  });
}

function importFailure(cause: unknown, message?: string): ImportCommandError {
  return new ImportCommandError({
    cause,
    message: message ?? errorMessage(cause),
  });
}

function fail(message: string, cause?: unknown): Effect.Effect<never, ImportCommandError> {
  return Effect.fail(
    cause === undefined
      ? new ImportCommandError({ message })
      : new ImportCommandError({ cause, message }),
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function reportFailure(error: ImportCommandError): Effect.Effect<void> {
  return Effect.sync(() => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

function printHelp(): void {
  console.log(`Import Earendil RFCs into Inkling

Usage:
  pnpm import-rfcs [--source PATH] [--url URL] [--api-key KEY] [--publish] [--dry-run]

Defaults:
  --source  ~/Development/earendil-rfcs
  --url     INKLING_URL or http://localhost:5173
  API key   INKLING_API_KEY

By default, public RFCs receive published revisions. Pass --publish to publish workspace-only RFCs too. The command is incremental: existing RFC numbers are updated, unchanged attachments are reused by digest, and RFCs are republished only after changes.`);
}
