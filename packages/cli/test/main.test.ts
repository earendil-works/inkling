import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
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
  "thread-delete",
  "trash",
  "undelete",
  "unpublish",
  "verify",
  "workspace",
  "workspace add",
  "workspace list",
  "workspace remove",
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

test("URL-derived workspaces route document IDs and complete URLs", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "inkling-cli-config-"));
  const configPath = path.join(directory, "config.json");
  const previousConfig = process.env["INKLING_CONFIG"];
  const originalFetch = globalThis.fetch;
  process.env["INKLING_CONFIG"] = configPath;

  try {
    assert.match(
      await captureOutput(main(["workspace", "add", "https://one.example", "key-one"])),
      /Registered one\.example\./u,
    );
    assert.match(
      await captureOutput(main(["workspace", "add", "http://localhost:8787", "key-two"])),
      /Registered localhost:8787\./u,
    );
    assert.match(await captureOutput(main(["workspace", "list"])), /one\.example/u);

    const config = JSON.parse(readFileSync(configPath, "utf8")) as {
      instances: { baseUrl: string; name: string }[];
    };
    assert.deepEqual(
      config.instances.map(({ baseUrl, name }) => ({ baseUrl, name })),
      [
        { baseUrl: "http://localhost:8787", name: "localhost:8787" },
        { baseUrl: "https://one.example", name: "one.example" },
      ],
    );

    const requests: { authorization: string | null; url: string }[] = [];
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      requests.push({
        authorization: headers.get("Authorization"),
        url: String(input),
      });
      return Promise.resolve(Response.json({}));
    }) as typeof fetch;

    await assert.rejects(
      Effect.runPromise(main(["read", "one.example", "doc_123"])),
      /unexpected response/u,
    );
    await assert.rejects(
      Effect.runPromise(main(["read", "https://one.example/documents/doc_789/edit"])),
      /unexpected response/u,
    );
    await assert.rejects(
      Effect.runPromise(main(["read", "http://localhost:8787/share/doc_456?cap=secret"])),
      /unexpected response/u,
    );
    await assert.rejects(
      Effect.runPromise(main(["read", "https://one.example/rfc/0042"])),
      /unexpected response/u,
    );
    await assert.rejects(
      Effect.runPromise(main(["read", "https://one.example/0042/"])),
      /unexpected response/u,
    );

    assert.deepEqual(requests, [
      {
        authorization: "Bearer key-one",
        url: "https://one.example/api/documents/doc_123",
      },
      {
        authorization: "Bearer key-one",
        url: "https://one.example/api/documents/doc_789",
      },
      {
        authorization: null,
        url: "http://localhost:8787/api/documents/doc_456?published=true&cap=secret",
      },
      {
        authorization: "Bearer key-one",
        url: "https://one.example/api/documents?q=rfc%3A42",
      },
      {
        authorization: "Bearer key-one",
        url: "https://one.example/api/documents?q=rfc%3A42",
      },
    ]);
    await assert.rejects(Effect.runPromise(main(["read", "one.example"])), /Missing document ID/u);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousConfig === undefined) delete process.env["INKLING_CONFIG"];
    else process.env["INKLING_CONFIG"] = previousConfig;
    rmSync(directory, { recursive: true });
  }
});

test("help accepts a command path and the local wrapper works through a symlink", async () => {
  const output = await captureOutput(main(["help", "workspace", "add"]));
  assert.match(output, /inkling workspace add URL API_KEY/u);

  const wrapper = path.resolve(import.meta.dirname, "../../../bin/inkling");
  const directory = mkdtempSync(path.join(tmpdir(), "inkling-cli-"));
  const linkedWrapper = path.join(directory, "inkling");
  symlinkSync(wrapper, linkedWrapper);

  try {
    const result = spawnSync(linkedWrapper, ["workspace", "add", "--help"], {
      encoding: "utf8",
      env: { ...process.env, INKLING_CONFIG: path.join(import.meta.dirname, "not-used.json") },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /inkling workspace add URL API_KEY/u);
    assert.doesNotMatch(result.stderr, /Missing URL/u);
  } finally {
    rmSync(directory, { recursive: true });
  }
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
