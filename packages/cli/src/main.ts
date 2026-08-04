#!/usr/bin/env node

import { Effect } from "effect";

import { startServer } from "@earendil-works/jot-runtime-node";
import type { DocumentResponse } from "@earendil-works/jot-protocol";

import { makeCliClient } from "./client.ts";
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
        const id = yield* documentArgument(instance, arguments_, 1);
        const oldText = yield* argument(arguments_, 2, "existing text");
        const newText = yield* argument(arguments_, 3, "replacement text");
        const current = yield* client.read(id);
        const updated = yield* client.edit(id, oldText, newText, current.metadata.headRevision);
        console.log(`Updated ${id} to revision ${updated.metadata.headRevision}.`);
        return;
      }
      case "metadata": {
        const id = yield* documentArgument(instance, arguments_, 1);
        const field = yield* argument(arguments_, 2, "field");
        const value = yield* argument(arguments_, 3, "value");
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
        const id = yield* documentArgument(instance, arguments_, 1);
        const access = yield* argument(arguments_, 2, "access");
        if (!new Set(["disabled", "view", "comment", "edit"]).has(access)) {
          return yield* usageFailure("Share access must be disabled, view, comment, or edit.");
        }
        const current = yield* client.read(id);
        const shared = yield* client.share(id, access, current.metadata.headRevision);
        console.log(shared.capabilityUrl ?? `Share access is now ${shared.policy.access}.`);
        return;
      }
      case "comment": {
        const id = yield* documentArgument(instance, arguments_, 1);
        const start = yield* argument(arguments_, 2, "start offset").pipe(
          Effect.flatMap((value) => positiveInteger(value, "start offset", true)),
        );
        const end = yield* argument(arguments_, 3, "end offset").pipe(
          Effect.flatMap((value) => positiveInteger(value, "end offset", true)),
        );
        const body = yield* argument(arguments_, 4, "comment body");
        const comments = yield* client.comment(id, start, end, body);
        console.log(`Created thread ${comments.threads.at(-1)?.id}.`);
        return;
      }
      case "reply": {
        const id = yield* documentArgument(instance, arguments_, 1);
        const threadId = yield* argument(arguments_, 2, "thread id");
        const parentId = yield* argument(arguments_, 3, "parent message id");
        const body = yield* argument(arguments_, 4, "reply body");
        const comments = yield* client.reply(id, threadId, parentId, body);
        const thread = comments.threads.find((item) => item.id === threadId);
        console.log(`Created message ${thread?.messages.at(-1)?.id}.`);
        return;
      }
      case "resolve":
      case "reopen": {
        const id = yield* documentArgument(instance, arguments_, 1);
        const threadId = yield* argument(arguments_, 2, "thread id");
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
  jot read [DOCUMENT] [--lines START:END]
  jot create TITLE [--rfc] [--body MARKDOWN]
  jot edit [DOCUMENT] OLD_TEXT NEW_TEXT
  jot metadata [DOCUMENT] FIELD VALUE
  jot delete|publish|unpublish [DOCUMENT]
  jot share [DOCUMENT] disabled|view|comment|edit
  jot comment [DOCUMENT] START_OFFSET END_OFFSET BODY
  jot reply [DOCUMENT] THREAD_ID PARENT_MESSAGE_ID BODY
  jot resolve|reopen [DOCUMENT] THREAD_ID

Set JOT_INSTANCE to override the active instance and JOT_AUTHOR for guest comments.`);
}
