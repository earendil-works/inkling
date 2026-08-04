#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { Effect } from "effect";

import { importEarendilRfc, importExistingJot } from "@earendil-works/jot-importers";
import type { ImportedDocument, PeopleDirectoryRecord } from "@earendil-works/jot-importers";
import type { ImportDocumentRequest } from "@earendil-works/jot-protocol";
import { startServer } from "@earendil-works/jot-runtime-node";
import type { DocumentResponse } from "@earendil-works/jot-protocol";

import { makeCliClient } from "./client.ts";
import type { CliClient } from "./client.ts";
import { loadConfig, saveConfig, selectedInstance, upsertInstance } from "./config.ts";
import type { Instance } from "./config.ts";

const args = process.argv.slice(2);

Effect.runPromise(main(args).pipe(Effect.catchAll(reportError))).catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

function main(arguments_: readonly string[]): Effect.Effect<void, unknown> {
  const command = arguments_[0];
  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    return Effect.sync(printHelp);
  }
  if (command === "serve") {
    const port = Number(option(arguments_, "--port") ?? process.env["PORT"] ?? "8787");
    const dataDirectory = option(arguments_, "--data-dir") ?? process.env["JOT_DATA_DIR"] ?? ".jot";
    return Number.isSafeInteger(port) && port > 0 && port <= 65_535
      ? Effect.scoped(
          startServer({
            dataDirectory,
            onListen: (listeningPort) =>
              console.log(`Jot is running at http://localhost:${listeningPort}`),
            port,
          }).pipe(Effect.zipRight(Effect.never)),
        )
      : usageFailure("--port must be an integer between 1 and 65535.");
  }
  if (command === "instance") return instanceCommand(arguments_.slice(1));
  if (command === "share-instance") return shareInstanceCommand(arguments_.slice(1));
  if (command === "use") {
    return argument(arguments_, 1, "instance name").pipe(Effect.flatMap(useCommand));
  }

  return Effect.gen(function* () {
    const config = yield* loadConfig();
    const instance = yield* selectedInstance(config);
    const client = makeCliClient(instance);

    switch (command) {
      case "import-rfc": {
        const source = yield* argument(arguments_, 1, "Markdown path");
        const markdown = yield* fileOperation("read RFC Markdown", () => readFile(source, "utf8"));
        const peoplePath = option(arguments_, "--people");
        const people =
          peoplePath === undefined
            ? undefined
            : yield* readJsonFile<readonly PeopleDirectoryRecord[]>(peoplePath);
        const imported = yield* importEarendilRfc(markdown, {
          now: new Date().toISOString(),
          people,
          sourcePath: source,
        });
        yield* uploadImportedDocument(client, imported, source, arguments_.includes("--publish"));
        return;
      }
      case "import-jot": {
        const source = yield* argument(arguments_, 1, "Markdown path");
        const sidecarPath = yield* argument(arguments_, 2, "metadata sidecar path");
        const markdown = yield* fileOperation("read Jot Markdown", () => readFile(source, "utf8"));
        const sidecar = yield* readJsonFile<unknown>(sidecarPath);
        const imported = yield* importExistingJot(markdown, sidecar, {
          now: new Date().toISOString(),
          sourcePath: source,
        });
        yield* uploadImportedDocument(client, imported, source, arguments_.includes("--publish"));
        return;
      }
      case "backup": {
        const destination = yield* argument(arguments_, 1, "destination path");
        const archive = yield* client.exportWorkspace;
        yield* fileOperation("write backup", () => writeFile(destination, archive));
        console.log(`Wrote ${archive.byteLength} bytes to ${destination}.`);
        return;
      }
      case "restore": {
        const source = yield* argument(arguments_, 1, "backup path");
        const archive = yield* fileOperation("read backup", () => readFile(source));
        const result = yield* client.restoreWorkspace(archive);
        console.log(`Restored and verified ${result.checkedObjects} objects.`);
        return;
      }
      case "verify": {
        const result = yield* client.verifyWorkspace;
        if (result.errors.length > 0) {
          for (const error of result.errors) console.error(error);
          return yield* usageFailure(
            `Workspace verification found ${result.errors.length} error(s).`,
          );
        }
        console.log(`Verified ${result.checkedObjects} objects.`);
        return;
      }
      case "list":
      case "search": {
        const query = command === "search" ? arguments_.slice(1).join(" ") : "";
        const result = yield* client.list(query);
        for (const document of result.documents) {
          const number =
            document.metadata.rfcNumber === undefined
              ? "       "
              : `RFC ${String(document.metadata.rfcNumber).padStart(4, "0")}`;
          console.log(
            `${number}  ${document.metadata.id}  ${document.metadata.lifecycleState.padEnd(12)}  ${document.metadata.title}`,
          );
        }
        return;
      }
      case "read": {
        const id = yield* documentArgument(instance, arguments_, 1);
        const range = yield* parseRange(option(arguments_, "--lines"));
        printDocument(yield* client.read(id, range));
        return;
      }
      case "create": {
        const title = yield* argument(arguments_, 1, "title");
        const body = option(arguments_, "--body") ?? (yield* readStandardInput());
        const created = yield* client.create(title, body, arguments_.includes("--rfc"));
        console.log(`${created.metadata.id}\t${created.metadata.title}`);
        return;
      }
      case "edit": {
        const target = yield* documentTarget(instance, arguments_, 1);
        const id = target.documentId;
        const oldText = yield* argument(arguments_, target.nextIndex, "existing text");
        const newText = yield* argument(arguments_, target.nextIndex + 1, "replacement text");
        const current = yield* client.read(id);
        const updated = yield* client.edit(id, oldText, newText, current.metadata.headRevision);
        console.log(`Updated ${id} to revision ${updated.metadata.headRevision}.`);
        return;
      }
      case "metadata": {
        const target = yield* documentTarget(instance, arguments_, 1);
        const id = target.documentId;
        const field = yield* argument(arguments_, target.nextIndex, "field");
        const value = yield* argument(arguments_, target.nextIndex + 1, "value");
        const current = yield* client.read(id);
        const updated = yield* client.metadata(id, {
          expectedRevision: current.metadata.headRevision,
          [field]: field === "labels" ? value.split(",").map((item) => item.trim()) : value,
        });
        console.log(`Updated ${updated.title} to revision ${updated.headRevision}.`);
        return;
      }
      case "delete": {
        const id = yield* documentArgument(instance, arguments_, 1);
        const current = yield* client.read(id);
        yield* client.remove(id, current.metadata.headRevision);
        console.log(`Deleted ${id}.`);
        return;
      }
      case "publish": {
        const id = yield* documentArgument(instance, arguments_, 1);
        const metadata = yield* client.publish(id);
        console.log(`Published ${id} at revision ${metadata.publishedRevision}.`);
        return;
      }
      case "unpublish": {
        const id = yield* documentArgument(instance, arguments_, 1);
        yield* client.unpublish(id);
        console.log(`Unpublished ${id}.`);
        return;
      }
      case "share": {
        const target = yield* documentTarget(instance, arguments_, 1);
        const id = target.documentId;
        const access = arguments_[target.nextIndex];
        if (access === undefined) {
          const current = yield* client.read(id);
          console.log(
            `${current.metadata.sharing.access}\tgeneration=${current.metadata.sharing.generation}${current.metadata.sharing.expiresAt === undefined ? "" : `\texpires=${current.metadata.sharing.expiresAt}`}`,
          );
          return;
        }
        if (!new Set(["disabled", "view", "comment", "edit"]).has(access)) {
          return yield* usageFailure("Share access must be disabled, view, comment, or edit.");
        }
        const current = yield* client.read(id);
        const shared = yield* client.share(id, access, current.metadata.headRevision);
        console.log(shared.capabilityUrl ?? `Share access is now ${shared.policy.access}.`);
        return;
      }
      case "attachment": {
        const action = yield* argument(arguments_, 1, "attachment action");
        if (action === "list") {
          const id = yield* documentArgument(instance, arguments_, 2);
          const attachments = yield* client.listAttachments(id);
          for (const attachment of attachments) {
            console.log(
              `${attachment.id}\t${attachment.size}\t${attachment.mediaType}\t${attachment.filename}`,
            );
          }
          return;
        }
        if (action === "upload") {
          const source = yield* argument(arguments_, 2, "file path");
          const id = yield* documentArgument(instance, arguments_, 3);
          const bytes = yield* fileOperation("read attachment", () => readFile(source));
          const mediaType = option(arguments_, "--type") ?? attachmentMediaType(source);
          const attachment = yield* client.uploadAttachment(
            id,
            path.basename(source),
            mediaType,
            bytes,
          );
          console.log(`${attachment.id}\t${attachment.url}`);
          return;
        }
        if (action === "download") {
          const attachmentId = yield* argument(arguments_, 2, "attachment id");
          const destination = yield* argument(arguments_, 3, "destination path");
          const id = yield* documentArgument(instance, arguments_, 4);
          const bytes = yield* client.downloadAttachment(id, attachmentId);
          yield* fileOperation("write attachment", () => writeFile(destination, bytes));
          console.log(`Wrote ${bytes.byteLength} bytes to ${destination}.`);
          return;
        }
        return yield* usageFailure("Attachment action must be list, upload, or download.");
      }
      case "comment": {
        const target = yield* documentTarget(instance, arguments_, 1);
        const id = target.documentId;
        const start = yield* argument(arguments_, target.nextIndex, "start offset").pipe(
          Effect.flatMap((value) => positiveInteger(value, "start offset", true)),
        );
        const end = yield* argument(arguments_, target.nextIndex + 1, "end offset").pipe(
          Effect.flatMap((value) => positiveInteger(value, "end offset", true)),
        );
        const body = yield* argument(arguments_, target.nextIndex + 2, "comment body");
        const comments = yield* client.comment(id, start, end, body);
        console.log(`Created thread ${comments.threads.at(-1)?.id}.`);
        return;
      }
      case "reply": {
        const target = yield* documentTarget(instance, arguments_, 1);
        const id = target.documentId;
        const threadId = yield* argument(arguments_, target.nextIndex, "thread id");
        const parentId = yield* argument(arguments_, target.nextIndex + 1, "parent message id");
        const body = yield* argument(arguments_, target.nextIndex + 2, "reply body");
        const comments = yield* client.reply(id, threadId, parentId, body);
        const thread = comments.threads.find((item) => item.id === threadId);
        console.log(`Created message ${thread?.messages.at(-1)?.id}.`);
        return;
      }
      case "comment-edit": {
        const target = yield* documentTarget(instance, arguments_, 1);
        const threadId = yield* argument(arguments_, target.nextIndex, "thread id");
        const messageId = yield* argument(arguments_, target.nextIndex + 1, "message id");
        const body = yield* argument(arguments_, target.nextIndex + 2, "comment body");
        yield* client.editComment(target.documentId, threadId, messageId, body);
        console.log(`Updated ${messageId}.`);
        return;
      }
      case "comment-delete": {
        const target = yield* documentTarget(instance, arguments_, 1);
        const threadId = yield* argument(arguments_, target.nextIndex, "thread id");
        const messageId = yield* argument(arguments_, target.nextIndex + 1, "message id");
        yield* client.deleteComment(target.documentId, threadId, messageId);
        console.log(`Deleted ${messageId}.`);
        return;
      }
      case "thread-delete": {
        const target = yield* documentTarget(instance, arguments_, 1);
        const threadId = yield* argument(arguments_, target.nextIndex, "thread id");
        yield* client.deleteThread(target.documentId, threadId);
        console.log(`Deleted ${threadId}.`);
        return;
      }
      case "resolve":
      case "reopen": {
        const target = yield* documentTarget(instance, arguments_, 1);
        const id = target.documentId;
        const threadId = yield* argument(arguments_, target.nextIndex, "thread id");
        yield* client.resolve(id, threadId, command === "resolve");
        console.log(`${command === "resolve" ? "Resolved" : "Reopened"} ${threadId}.`);
        return;
      }
      default:
        return yield* usageFailure(`Unknown command: ${command}`);
    }
  });
}

function instanceCommand(arguments_: readonly string[]): Effect.Effect<void, unknown> {
  const action = arguments_[0];
  return Effect.gen(function* () {
    const config = yield* loadConfig();
    if (action === "list") {
      for (const instance of config.instances) {
        console.log(
          `${instance.name === config.active ? "*" : " "} ${instance.name}\t${instance.baseUrl}`,
        );
      }
      return;
    }
    if (action === "add") {
      const name = yield* argument(arguments_, 1, "name");
      const baseUrl = yield* argument(arguments_, 2, "URL").pipe(Effect.flatMap(normalizedBaseUrl));
      const apiKey = yield* argument(arguments_, 3, "API key");
      yield* saveConfig(upsertInstance(config, { apiKey, baseUrl, name }));
      console.log(`Registered ${name}.`);
      return;
    }
    if (action === "remove") {
      const name = yield* argument(arguments_, 1, "name");
      yield* saveConfig({
        ...config,
        active: config.active === name ? undefined : config.active,
        instances: config.instances.filter((instance) => instance.name !== name),
      });
      console.log(`Removed ${name}.`);
      return;
    }
    return yield* usageFailure("Usage: jot instance add|remove|list");
  });
}

function shareInstanceCommand(arguments_: readonly string[]): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    const name = yield* argument(arguments_, 0, "name");
    const capabilityUrl = yield* argument(arguments_, 1, "capability URL").pipe(
      Effect.flatMap(parseUrl),
    );
    const match = /^\/share\/([^/]+)$/u.exec(capabilityUrl.pathname);
    const capabilityToken = capabilityUrl.searchParams.get("cap");
    if (match?.[1] === undefined || capabilityToken === null) {
      return yield* usageFailure("The shared URL is not a Jot capability URL.");
    }
    const config = yield* loadConfig();
    yield* saveConfig(
      upsertInstance(config, {
        baseUrl: capabilityUrl.origin,
        capabilityToken,
        documentId: decodeURIComponent(match[1]),
        name,
      }),
    );
    console.log(`Registered shared document as ${name}.`);
  });
}

function useCommand(name: string): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    const config = yield* loadConfig();
    if (!config.instances.some((instance) => instance.name === name)) {
      return yield* usageFailure(`Unknown instance: ${name}`);
    }
    yield* saveConfig({ ...config, active: name });
    console.log(`Using ${name}.`);
  });
}

function printDocument(document: DocumentResponse): void {
  const metadata = document.metadata;
  console.log(
    `${metadata.rfcNumber === undefined ? "Document" : `RFC ${String(metadata.rfcNumber).padStart(4, "0")}`}: ${metadata.title}`,
  );
  console.log(`ID: ${metadata.id}`);
  console.log(`Revision: ${metadata.headRevision}`);
  console.log(`State: ${metadata.lifecycleState}`);
  console.log(
    `Visibility: ${metadata.visibility}${metadata.sensitivity === "confidential" ? " / CONFIDENTIAL" : ""}`,
  );
  console.log("\n---\n");
  console.log(document.body);
  if (document.comments.threads.length > 0) {
    console.log("\n--- Comments ---");
    for (const thread of document.comments.threads) {
      console.log(
        `\nThread ${thread.id}${thread.resolved ? " (resolved)" : ""}: ${thread.anchor.quote}`,
      );
      for (const message of thread.messages) {
        console.log(
          `  ${message.id}${message.parentId === undefined ? "" : ` reply-to=${message.parentId}`} ${message.authorDisplayName}: ${message.body}`,
        );
      }
    }
  }
}

function parseRange(
  value: string | undefined,
): Effect.Effect<{ readonly start: number; readonly end: number } | undefined, Error> {
  if (value === undefined) return Effect.succeed(undefined);
  const match = /^(\d+):(\d+)$/u.exec(value);
  if (match?.[1] === undefined || match[2] === undefined) {
    return usageFailure("Line range must use START:END.");
  }
  return Effect.all({
    end: positiveInteger(match[2], "end line"),
    start: positiveInteger(match[1], "start line"),
  });
}

function documentTarget(
  instance: Instance,
  arguments_: readonly string[],
  index: number,
): Effect.Effect<{ readonly documentId: string; readonly nextIndex: number }, Error> {
  return instance.documentId === undefined
    ? argument(arguments_, index, "document id").pipe(
        Effect.map((documentId) => ({ documentId, nextIndex: index + 1 })),
      )
    : Effect.succeed({ documentId: instance.documentId, nextIndex: index });
}

function documentArgument(
  instance: Instance,
  arguments_: readonly string[],
  index: number,
): Effect.Effect<string, Error> {
  return instance.documentId === undefined
    ? argument(arguments_, index, "document id")
    : Effect.succeed(instance.documentId);
}

function option(arguments_: readonly string[], name: string): string | undefined {
  const index = arguments_.indexOf(name);
  return index === -1 ? undefined : arguments_[index + 1];
}

function argument(
  arguments_: readonly string[],
  index: number,
  label: string,
): Effect.Effect<string, Error> {
  const value = arguments_[index];
  return value === undefined || value.startsWith("--")
    ? usageFailure(`Missing ${label}.`)
    : Effect.succeed(value);
}

function positiveInteger(
  value: string,
  label: string,
  allowZero = false,
): Effect.Effect<number, Error> {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= (allowZero ? 0 : 1)
    ? Effect.succeed(parsed)
    : usageFailure(`${label} must be ${allowZero ? "a non-negative" : "a positive"} integer.`);
}

function parseUrl(value: string): Effect.Effect<URL, Error> {
  return Effect.try({
    catch: () => new Error("The value must be a valid URL."),
    try: () => new URL(value),
  });
}

function normalizedBaseUrl(value: string): Effect.Effect<string, Error> {
  return parseUrl(value).pipe(
    Effect.flatMap((url) =>
      url.protocol === "http:" || url.protocol === "https:"
        ? Effect.succeed(url.href)
        : usageFailure("Jot instance URLs must use HTTP or HTTPS."),
    ),
  );
}

function uploadImportedDocument(
  client: CliClient,
  imported: ImportedDocument,
  sourcePath: string,
  forcePublish: boolean,
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    const request: ImportDocumentRequest = {
      body: imported.body,
      comments: imported.comments.map((thread) => ({
        legacyId: thread.legacyId,
        messages: thread.messages.map((message) => ({
          authorDisplayName: message.author,
          body: message.body,
          createdAt: message.createdAt,
          legacyId: message.legacyId,
          parentLegacyId: message.parentLegacyId,
          updatedAt: message.updatedAt,
        })),
        originalEnd: thread.originalEnd,
        originalStart: thread.originalStart,
        prefix: thread.prefix,
        quote: thread.quote,
        resolved: thread.resolved,
        suffix: thread.suffix,
      })),
      metadata: imported.metadata,
      publish: false,
    };
    let created = yield* client.importDocument(request);
    let rewrittenBody = imported.body;
    const attachments = importedAttachments(imported, sourcePath);
    for (const attachment of attachments) {
      const bytes = yield* fileOperation(`read imported attachment ${attachment.sourcePath}`, () =>
        readFile(attachment.sourcePath),
      );
      const uploaded = yield* client.uploadAttachment(
        created.metadata.id,
        path.basename(attachment.sourcePath),
        attachment.mediaType ?? attachmentMediaType(attachment.sourcePath),
        bytes,
      );
      rewrittenBody = rewrittenBody.replaceAll(attachment.markdownPath, uploaded.url);
    }
    if (rewrittenBody !== imported.body) {
      created = yield* client.replaceBody(
        created.metadata.id,
        rewrittenBody,
        created.metadata.headRevision,
      );
    }
    if (forcePublish || imported.metadata.visibility === "public") {
      yield* client.publish(created.metadata.id);
    }
    console.log(`${created.metadata.id}\t${created.metadata.title}`);
    for (const warning of imported.warnings) console.error(`warning: ${warning}`);
    if (imported.relatedRfcNumbers.length > 0) {
      console.error(
        `warning: related RFC numbers require document ID mapping: ${imported.relatedRfcNumbers.join(", ")}`,
      );
    }
  });
}

function importedAttachments(
  imported: ImportedDocument,
  sourcePath: string,
): readonly {
  readonly sourcePath: string;
  readonly markdownPath: string;
  readonly mediaType?: string;
}[] {
  const declared = imported.attachments.map((attachment) => ({
    markdownPath: attachment.markdownPath,
    mediaType: attachment.mediaType,
    sourcePath: path.resolve(path.dirname(sourcePath), attachment.sourcePath),
  }));
  const discovered = [
    ...imported.body.matchAll(/!\[[^\]]*\]\((?!https?:|\/|data:)([^\s)]+)(?:\s+"[^"]*")?\)/giu),
  ]
    .flatMap((match) => (match[1] === undefined ? [] : [match[1]]))
    .map((markdownPath) => ({
      markdownPath,
      sourcePath: path.resolve(path.dirname(sourcePath), markdownPath),
    }));
  return [...declared, ...discovered].filter(
    (attachment, index, all) =>
      all.findIndex((candidate) => candidate.markdownPath === attachment.markdownPath) === index,
  );
}

function readJsonFile<A>(filename: string): Effect.Effect<A, Error> {
  return fileOperation("read JSON file", () => readFile(filename, "utf8")).pipe(
    Effect.flatMap((source) =>
      Effect.try({
        catch: (cause) => new Error(`Could not parse ${filename} as JSON.`, { cause }),
        try: () => JSON.parse(source) as A,
      }),
    ),
  );
}

function fileOperation<A>(label: string, operation: () => Promise<A>): Effect.Effect<A, Error> {
  return Effect.tryPromise({
    catch: (cause) => new Error(`Could not ${label}.`, { cause }),
    try: operation,
  });
}

function attachmentMediaType(filename: string): string {
  switch (path.extname(filename).toLowerCase()) {
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

function readStandardInput(): Effect.Effect<string, unknown> {
  return process.stdin.isTTY
    ? Effect.succeed("")
    : Effect.tryPromise({
        catch: (cause) => cause,
        try: async () => {
          const chunks: Buffer[] = [];
          for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
          return Buffer.concat(chunks).toString("utf8");
        },
      });
}

function usageFailure(message: string): Effect.Effect<never, Error> {
  return Effect.fail(new Error(message));
}

function reportError(error: unknown): Effect.Effect<void> {
  return Effect.sync(() => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

function printHelp(): void {
  console.log(`Jot — multiplayer Markdown for people and agents

Usage:
  jot serve [--port PORT] [--data-dir PATH]
  jot instance add NAME URL API_KEY
  jot instance remove NAME | jot instance list | jot use NAME
  jot share-instance NAME CAPABILITY_URL
  jot list | jot search QUERY
  jot import-rfc MARKDOWN [--people PEOPLE_JSON] [--publish]
  jot import-jot MARKDOWN SIDECAR_JSON [--publish]
  jot backup DESTINATION | jot restore BACKUP | jot verify
  jot read [DOCUMENT] [--lines START:END]
  jot create TITLE [--rfc] [--body MARKDOWN]
  jot edit [DOCUMENT] OLD_TEXT NEW_TEXT
  jot metadata [DOCUMENT] FIELD VALUE
  jot delete|publish|unpublish [DOCUMENT]
  jot share [DOCUMENT] disabled|view|comment|edit
  jot attachment list [DOCUMENT]
  jot attachment upload FILE [DOCUMENT] [--type MEDIA_TYPE]
  jot attachment download ATTACHMENT_ID DESTINATION [DOCUMENT]
  jot comment [DOCUMENT] START_OFFSET END_OFFSET BODY
  jot reply [DOCUMENT] THREAD_ID PARENT_MESSAGE_ID BODY
  jot comment-edit [DOCUMENT] THREAD_ID MESSAGE_ID BODY
  jot comment-delete [DOCUMENT] THREAD_ID MESSAGE_ID
  jot thread-delete [DOCUMENT] THREAD_ID
  jot resolve|reopen [DOCUMENT] THREAD_ID

Set JOT_INSTANCE to override the active instance and JOT_AUTHOR for guest comments.`);
}
