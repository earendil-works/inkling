#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { Effect } from "effect";

import { importEarendilRfc, importExistingJot } from "@earendil-works/inkling-importers";
import type { ImportedDocument, PeopleDirectoryRecord } from "@earendil-works/inkling-importers";
import type { ImportDocumentRequest } from "@earendil-works/inkling-protocol";
import { startServer } from "@earendil-works/inkling-runtime-node";
import type { DocumentResponse } from "@earendil-works/inkling-protocol";

import { makeCliClient } from "./client.ts";
import type { CliClient } from "./client.ts";
import {
  configuredWorkspace,
  loadConfig,
  saveConfig,
  upsertWorkspace,
  workspaceName,
} from "./config.ts";
import type { Config, Instance } from "./config.ts";
import { renderHelp, requestedHelp } from "./help.ts";

if (import.meta.main) {
  Effect.runPromise(main(process.argv.slice(2)).pipe(Effect.catchAll(reportError))).catch(
    (error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
}

export function main(arguments_: readonly string[]): Effect.Effect<void, unknown> {
  const help = requestedHelp(arguments_);
  if (help !== undefined) {
    const output = renderHelp(help.topic);
    return output === undefined
      ? usageFailure(`Unknown help topic: ${help.topic}`)
      : Effect.sync(() => console.log(output.trimEnd()));
  }
  const command = arguments_[0];
  if (command === undefined) return usageFailure("Missing command.");
  if (command === "serve") {
    const port = Number(option(arguments_, "--port") ?? process.env["PORT"] ?? "8787");
    const dataDirectory =
      option(arguments_, "--data-dir") ?? process.env["INKLING_DATA_DIR"] ?? ".inkling";
    return Number.isSafeInteger(port) && port > 0 && port <= 65_535
      ? Effect.scoped(
          startServer({
            dataDirectory,
            onListen: (listeningPort) =>
              console.log(`Inkling is running at http://localhost:${listeningPort}`),
            port,
          }).pipe(Effect.zipRight(Effect.never)),
        )
      : usageFailure("--port must be an integer between 1 and 65535.");
  }
  if (command === "workspace") return workspaceCommand(arguments_.slice(1));

  return Effect.gen(function* () {
    const config = yield* loadConfig();
    const instance = yield* commandInstance(config, command, arguments_);
    const client = makeCliClient(instance);

    switch (command) {
      case "import-rfc": {
        const source = yield* argument(arguments_, 2, "Markdown path");
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
        const source = yield* argument(arguments_, 2, "Markdown path");
        const sidecarPath = yield* argument(arguments_, 3, "metadata sidecar path");
        const markdown = yield* fileOperation("read legacy Jot Markdown", () =>
          readFile(source, "utf8"),
        );
        const sidecar = yield* readJsonFile<unknown>(sidecarPath);
        const imported = yield* importExistingJot(markdown, sidecar, {
          now: new Date().toISOString(),
          sourcePath: source,
        });
        yield* uploadImportedDocument(client, imported, source, arguments_.includes("--publish"));
        return;
      }
      case "backup": {
        const destination = yield* argument(arguments_, 2, "destination path");
        const archive = yield* client.exportWorkspace;
        yield* fileOperation("write backup", () => writeFile(destination, archive));
        console.log(`Wrote ${archive.byteLength} bytes to ${destination}.`);
        return;
      }
      case "restore": {
        const source = yield* argument(arguments_, 2, "backup path");
        const archive = yield* fileOperation("read backup", () => readFile(source));
        const result = yield* client.restoreWorkspace(archive);
        console.log(`Restored and verified ${result.checkedObjects} objects.`);
        return;
      }
      case "repair": {
        const result = yield* client.repairCatalog;
        if (result.errors.length > 0) {
          for (const error of result.errors) console.error(error);
          return yield* usageFailure(
            `Catalog repair found ${result.errors.length} unrecoverable document(s).`,
          );
        }
        console.log(`Rebuilt the catalog from ${result.checkedObjects} checkpoints.`);
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
        const query = command === "search" ? arguments_.slice(2).join(" ") : "";
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
        const target = yield* documentTarget(client, arguments_, 1);
        const range = yield* parseRange(option(arguments_, "--lines"));
        printDocument(yield* client.read(target.documentId, range, target.published));
        return;
      }
      case "create": {
        const title = yield* argument(arguments_, 2, "title");
        const body = option(arguments_, "--body") ?? (yield* readStandardInput());
        const created = yield* client.create(title, body, arguments_.includes("--rfc"));
        console.log(`${created.metadata.id}\t${created.metadata.title}`);
        return;
      }
      case "edit": {
        const target = yield* documentTarget(client, arguments_, 1);
        const id = target.documentId;
        const oldText = yield* argument(arguments_, target.nextIndex, "existing text");
        const newText = yield* argument(arguments_, target.nextIndex + 1, "replacement text");
        const current = yield* client.read(id);
        const updated = yield* client.edit(id, oldText, newText, current.metadata.headRevision);
        console.log(`Updated ${id} to revision ${updated.metadata.headRevision}.`);
        return;
      }
      case "replace": {
        const target = yield* documentTarget(client, arguments_, 1);
        const source = yield* argument(arguments_, target.nextIndex, "Markdown path or -");
        const body =
          source === "-"
            ? yield* readStandardInput()
            : yield* fileOperation("read replacement Markdown", () => readFile(source, "utf8"));
        const current = yield* client.read(target.documentId);
        const updated = yield* client.replaceBody(
          target.documentId,
          body,
          current.metadata.headRevision,
        );
        console.log(`Replaced ${target.documentId} at revision ${updated.metadata.headRevision}.`);
        return;
      }
      case "metadata": {
        const target = yield* documentTarget(client, arguments_, 1);
        const id = target.documentId;
        const field = yield* argument(arguments_, target.nextIndex, "field");
        const value = yield* argument(arguments_, target.nextIndex + 1, "value");
        const current = yield* client.read(id);
        const patch = yield* metadataFieldPatch(field, value);
        const updated = yield* client.metadata(id, {
          ...patch,
          expectedRevision: current.metadata.headRevision,
        });
        console.log(`Updated ${updated.title} to revision ${updated.headRevision}.`);
        return;
      }
      case "delete": {
        const id = (yield* documentTarget(client, arguments_, 1)).documentId;
        if (arguments_.includes("--hard")) {
          const trash = yield* client.listDeleted;
          const document = trash.documents.find((candidate) => candidate.metadata.id === id);
          if (document === undefined) {
            return yield* usageFailure("Only documents in Trash can be permanently deleted.");
          }
          yield* client.hardDeleteDocument(id, document.metadata.headRevision);
          console.log(`Permanently deleted ${id}.`);
          return;
        }
        const current = yield* client.read(id);
        yield* client.remove(id, current.metadata.headRevision);
        console.log(`Moved ${id} to Trash.`);
        return;
      }
      case "trash": {
        const result = yield* client.listDeleted;
        for (const document of result.documents) {
          console.log(
            `${document.metadata.id}\t${document.metadata.deletedAt ?? "unknown"}\t${document.metadata.title}`,
          );
        }
        return;
      }
      case "undelete": {
        const id = (yield* documentTarget(client, arguments_, 1)).documentId;
        const trash = yield* client.listDeleted;
        const document = trash.documents.find((candidate) => candidate.metadata.id === id);
        if (document === undefined) return yield* usageFailure("The document is not in Trash.");
        yield* client.restoreDocument(id, document.metadata.headRevision);
        console.log(`Restored ${id}.`);
        return;
      }
      case "publish": {
        const id = (yield* documentTarget(client, arguments_, 1)).documentId;
        const metadata = yield* client.publish(id);
        console.log(`Published ${id} at revision ${metadata.publishedRevision}.`);
        return;
      }
      case "unpublish": {
        const id = (yield* documentTarget(client, arguments_, 1)).documentId;
        yield* client.unpublish(id);
        console.log(`Unpublished ${id}.`);
        return;
      }
      case "share": {
        const target = yield* documentTarget(client, arguments_, 1);
        const id = target.documentId;
        const access = arguments_[target.nextIndex];
        const active = yield* client.listShareLinks(id);
        if (access === undefined) {
          if (active.links.length === 0) console.log("No active share links.");
          for (const link of active.links) {
            console.log(
              `${link.id}\t${link.access}\t${link.passwordProtected ? "password" : "unprotected"}\t${link.url ?? "URL unavailable"}`,
            );
          }
          return;
        }
        if (access === "disabled") {
          let revision = (yield* client.read(id)).metadata.headRevision;
          for (const link of active.links) {
            yield* client.deleteShareLink(id, link.id, revision);
            revision += 1;
          }
          console.log("Deleted all share links.");
          return;
        }
        if (!isShareAccess(access)) {
          return yield* usageFailure("Share access must be disabled, view, comment, or edit.");
        }
        const current = yield* client.read(id);
        const shared = yield* client.createShareLink(id, access, current.metadata.headRevision);
        const created = shared.links.find(
          (link) => link.access === access && !link.passwordProtected,
        );
        console.log(created?.url ?? "Share link created.");
        return;
      }
      case "attachment": {
        const action = yield* argument(arguments_, 1, "attachment action");
        if (action === "list") {
          const id = (yield* documentTarget(client, arguments_, 2)).documentId;
          const attachments = yield* client.listAttachments(id);
          for (const attachment of attachments) {
            console.log(
              `${attachment.id}\t${attachment.size}\t${attachment.mediaType}\t${attachment.filename}`,
            );
          }
          return;
        }
        if (action === "upload") {
          const target = yield* documentTarget(client, arguments_, 2);
          const source = yield* argument(arguments_, target.nextIndex, "file path");
          const id = target.documentId;
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
          const target = yield* documentTarget(client, arguments_, 2);
          const attachmentId = yield* argument(arguments_, target.nextIndex, "attachment id");
          const destination = yield* argument(arguments_, target.nextIndex + 1, "destination path");
          const id = target.documentId;
          const bytes = yield* client.downloadAttachment(id, attachmentId);
          yield* fileOperation("write attachment", () => writeFile(destination, bytes));
          console.log(`Wrote ${bytes.byteLength} bytes to ${destination}.`);
          return;
        }
        return yield* usageFailure("Attachment action must be list, upload, or download.");
      }
      case "comment": {
        const target = yield* documentTarget(client, arguments_, 1);
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
        const target = yield* documentTarget(client, arguments_, 1);
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
        const target = yield* documentTarget(client, arguments_, 1);
        const threadId = yield* argument(arguments_, target.nextIndex, "thread id");
        const messageId = yield* argument(arguments_, target.nextIndex + 1, "message id");
        const body = yield* argument(arguments_, target.nextIndex + 2, "comment body");
        yield* client.editComment(target.documentId, threadId, messageId, body);
        console.log(`Updated ${messageId}.`);
        return;
      }
      case "comment-delete": {
        const target = yield* documentTarget(client, arguments_, 1);
        const threadId = yield* argument(arguments_, target.nextIndex, "thread id");
        const messageId = yield* argument(arguments_, target.nextIndex + 1, "message id");
        yield* client.deleteComment(target.documentId, threadId, messageId);
        console.log(`Deleted ${messageId}.`);
        return;
      }
      case "thread-delete": {
        const target = yield* documentTarget(client, arguments_, 1);
        const threadId = yield* argument(arguments_, target.nextIndex, "thread id");
        yield* client.deleteThread(target.documentId, threadId);
        console.log(`Deleted ${threadId}.`);
        return;
      }
      case "resolve":
      case "reopen": {
        const target = yield* documentTarget(client, arguments_, 1);
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

function workspaceCommand(arguments_: readonly string[]): Effect.Effect<void, unknown> {
  const action = arguments_[0];
  return Effect.gen(function* () {
    const config = yield* loadConfig();
    if (action === "list") {
      for (const instance of config.instances.filter(
        (candidate) => candidate.apiKey !== undefined,
      )) {
        console.log(`${workspaceName(instance.baseUrl)}\t${instance.baseUrl}`);
      }
      return;
    }
    if (action === "add") {
      const baseUrl = yield* argument(arguments_, 1, "URL").pipe(Effect.flatMap(normalizedBaseUrl));
      const apiKey = yield* argument(arguments_, 2, "API key");
      const workspace = workspaceName(baseUrl);
      yield* saveConfig(upsertWorkspace(config, { apiKey, baseUrl, name: workspace }));
      console.log(`Registered ${workspace}.`);
      return;
    }
    if (action === "remove") {
      const workspace = yield* argument(arguments_, 1, "workspace").pipe(
        Effect.flatMap(normalizedWorkspaceName),
      );
      yield* saveConfig({
        instances: config.instances.filter(
          (instance) => workspaceName(instance.baseUrl) !== workspace,
        ),
        version: 1,
      });
      console.log(`Removed ${workspace}.`);
      return;
    }
    return yield* usageFailure("Usage: inkling workspace add|remove|list");
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
  console.log(`Visibility: ${metadata.visibility}`);
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

function metadataFieldPatch(
  field: string,
  value: string,
): Effect.Effect<Readonly<Record<string, unknown>>, Error> {
  if (new Set(["authors", "reviewers", "approvers"]).has(field)) {
    const people = value.split(",").map((item) => {
      const match = /^\s*(.*?)\s*<([^>]+)>\s*$/u.exec(item);
      const email = match?.[2]?.trim();
      return {
        displayName: match?.[1]?.trim() || email || "",
        email: email ?? "",
        id: email?.toLocaleLowerCase("en") ?? "",
      };
    });
    return people.every((person) => person.displayName.length > 0 && person.email.includes("@"))
      ? Effect.succeed({ [field]: people })
      : usageFailure(`${field} must use Name <email>, separated by commas.`);
  }
  if (field === "labels") {
    return Effect.succeed({
      labels: value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    });
  }
  if (field === "relatedDocuments") {
    return Effect.succeed({
      relatedDocuments: value.split(",").map((item) => {
        const [documentId, relationship] = item.trim().split(":", 2);
        return relationship === undefined ? { documentId } : { documentId, relationship };
      }),
    });
  }
  if (field === "targetDecisionDate" || field === "legacySourceUrl") {
    return Effect.succeed({ [field]: value === "none" ? null : value });
  }
  if (new Set(["lifecycleState", "visibility"]).has(field)) {
    return Effect.succeed({ [field]: value });
  }
  return usageFailure(`Unsupported metadata field: ${field}`);
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

function commandInstance(
  config: Config,
  command: string,
  arguments_: readonly string[],
): Effect.Effect<Instance, Error> {
  const index = command === "attachment" ? 2 : 1;
  return argument(arguments_, index, "workspace or document URL").pipe(
    Effect.flatMap((value) => {
      const url = optionalHttpUrl(value);
      if (url === undefined) {
        return normalizedWorkspaceName(value).pipe(
          Effect.flatMap((workspace) => configuredWorkspace(config, workspace)),
        );
      }

      const shared = /^\/share\/([^/]+)(?:\/edit)?\/?$/u.exec(url.pathname);
      if (url.pathname.startsWith("/share/")) {
        const capabilityToken = url.searchParams.get("cap");
        if (shared?.[1] === undefined || capabilityToken === null || capabilityToken === "") {
          return usageFailure("The shared URL is not an Inkling capability URL.");
        }
        return decodeDocumentId(shared[1]).pipe(
          Effect.map((documentId) => ({
            baseUrl: url.origin,
            capabilityToken,
            documentId,
            name: url.host,
          })),
        );
      }

      return configuredWorkspace(config, url.host).pipe(
        Effect.mapError(
          () =>
            new Error(
              `No Inkling workspace is configured for ${url.origin}. Read ${url.origin}/AGENTS.md and ask the user to connect it.`,
            ),
        ),
        Effect.flatMap((instance) => {
          const configuredOrigin = URL.parse(instance.baseUrl)?.origin;
          return configuredOrigin === url.origin
            ? Effect.succeed(instance)
            : usageFailure(
                `Workspace ${url.host} is configured at ${configuredOrigin ?? instance.baseUrl}, not ${url.origin}.`,
              );
        }),
      );
    }),
  );
}

function optionalHttpUrl(value: string | undefined): URL | undefined {
  if (value === undefined) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
}

function documentTarget(
  client: CliClient,
  arguments_: readonly string[],
  index: number,
): Effect.Effect<
  { readonly documentId: string; readonly nextIndex: number; readonly published: boolean },
  Error
> {
  return argument(arguments_, index, "workspace or document URL").pipe(
    Effect.flatMap((value) => {
      const url = optionalHttpUrl(value);
      if (url === undefined) {
        return argument(arguments_, index + 1, "document ID").pipe(
          Effect.map((documentId) => ({
            documentId,
            nextIndex: index + 2,
            published: false,
          })),
        );
      }

      const document = /^\/(?:public\/)?documents\/([^/]+)(?:\/(edit))?\/?$/u.exec(url.pathname);
      const shared = /^\/share\/([^/]+)(?:\/(edit))?\/?$/u.exec(url.pathname);
      const direct = document ?? shared;
      if (direct?.[1] !== undefined) {
        return decodeDocumentId(direct[1]).pipe(
          Effect.map((documentId) => ({
            documentId,
            nextIndex: index + 1,
            published: direct[2] !== "edit",
          })),
        );
      }

      const rfc = /^\/rfcs\/(\d+)(?:\/(edit))?\/?$/u.exec(url.pathname);
      const number = Number(rfc?.[1]);
      if (rfc?.[1] === undefined || !Number.isSafeInteger(number) || number < 1) {
        return usageFailure("The URL is not a supported Inkling document URL.");
      }
      return client.list(`rfc:${number}`).pipe(
        Effect.flatMap((catalog) => {
          const match = catalog.documents.find(
            (candidate) => candidate.metadata.rfcNumber === number,
          );
          return match === undefined
            ? usageFailure(`RFC ${String(number).padStart(4, "0")} is not available.`)
            : Effect.succeed({
                documentId: match.metadata.id,
                nextIndex: index + 1,
                published: rfc[2] !== "edit",
              });
        }),
      );
    }),
  );
}

function decodeDocumentId(value: string): Effect.Effect<string, Error> {
  return Effect.try({
    catch: () => new Error("The Inkling document URL is invalid."),
    try: () => decodeURIComponent(value),
  });
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
    Effect.flatMap((url) => {
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        return usageFailure("Inkling workspace URLs must use HTTP or HTTPS.");
      }
      if (
        url.username !== "" ||
        url.password !== "" ||
        url.pathname !== "/" ||
        url.search !== "" ||
        url.hash !== ""
      ) {
        return usageFailure("Inkling workspace URLs must contain only an origin.");
      }
      return Effect.succeed(url.origin);
    }),
  );
}

function normalizedWorkspaceName(value: string): Effect.Effect<string, Error> {
  const url = optionalHttpUrl(value) ?? optionalHttpUrl(`https://${value}`);
  return url === undefined ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
    ? usageFailure("Workspace selectors must use DOMAIN or DOMAIN:PORT.")
    : Effect.succeed(url.host);
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
      people: imported.people,
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
    for (const thread of imported.comments) {
      if (!importedCommentCanAnchor(imported.body, thread)) {
        console.error(
          `warning: skipped comment thread ${thread.legacyId ?? "without legacy ID"}; its quote is missing or ambiguous`,
        );
      }
    }
    if (imported.relatedRfcNumbers.length > 0) {
      console.error(
        `warning: related RFC numbers require document ID mapping: ${imported.relatedRfcNumbers.join(", ")}`,
      );
    }
  });
}

function importedCommentCanAnchor(
  body: string,
  thread: ImportedDocument["comments"][number],
): boolean {
  if (
    thread.originalStart !== undefined &&
    thread.originalEnd !== undefined &&
    thread.originalStart <= thread.originalEnd &&
    body.slice(thread.originalStart, thread.originalEnd) === thread.quote
  ) {
    return true;
  }
  const first = body.indexOf(thread.quote);
  return thread.quote.length > 0 && first !== -1 && body.indexOf(thread.quote, first + 1) === -1;
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

function isShareAccess(value: string): value is "view" | "comment" | "edit" {
  return value === "view" || value === "comment" || value === "edit";
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
