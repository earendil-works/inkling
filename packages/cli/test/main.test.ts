import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

import { Effect } from "effect";

import { helpTopicNames, renderHelp, requestedHelp } from "../src/help.ts";
import { main } from "../src/main.ts";

const expectedHelpTopics = [
  "",
  "attachment",
  "attachment download",
  "attachment list",
  "attachment upload",
  "backup",
  "comment",
  "comment-delete",
  "comment-edit",
  "create",
  "delete",
  "edit",
  "import-jot",
  "import-rfc",
  "instance",
  "instance add",
  "instance list",
  "instance remove",
  "list",
  "metadata",
  "publish",
  "read",
  "reopen",
  "repair",
  "replace",
  "reply",
  "resolve",
  "restore",
  "search",
  "serve",
  "share",
  "share-instance",
  "thread-delete",
  "trash",
  "undelete",
  "unpublish",
  "use",
  "verify",
];

test("every CLI command and subcommand has command-specific help", () => {
  assert.deepEqual(helpTopicNames.toSorted(), expectedHelpTopics);
  for (const topic of expectedHelpTopics) {
    const commandArguments = topic === "" ? ["--help"] : [...topic.split(" "), "--help"];
    const request = requestedHelp(commandArguments);
    assert.equal(request?.topic, topic);
    const output = renderHelp(topic) ?? "";
    assert.match(output, /Usage:/u, topic || "root");
    assert.match(output, /-h, --help\s+Show this help message\./u, topic || "root");
    if (topic !== "") assert.match(output, new RegExp(`inkling ${topic.replace(" ", "\\s+")}`));
    assert.doesNotMatch(output, /Missing /u, topic || "root");
  }
});

test("help accepts a command path and the local wrapper handles nested help before arguments", async () => {
  const output = await captureOutput(main(["help", "instance", "add"]));
  assert.match(output, /inkling instance add NAME URL API_KEY/u);

  const wrapper = path.resolve(import.meta.dirname, "../../../bin/inkling");
  const result = spawnSync(wrapper, ["instance", "add", "--help"], {
    encoding: "utf8",
    env: { ...process.env, INKLING_CONFIG: path.join(import.meta.dirname, "not-used.json") },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /inkling instance add NAME URL API_KEY/u);
  assert.doesNotMatch(result.stderr, /Missing name/u);
});

async function captureOutput(effect: Effect.Effect<void, unknown>): Promise<string> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...values: readonly unknown[]) => lines.push(values.map(String).join(" "));
  try {
    await Effect.runPromise(effect);
  } finally {
    console.log = original;
  }
  return lines.join("\n");
}
