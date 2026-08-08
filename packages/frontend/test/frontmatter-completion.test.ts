import assert from "node:assert/strict";
import test from "node:test";

import { CompletionContext } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";

import { makeFrontmatterCompletionSource } from "../src/frontmatter-completion.ts";

const source = makeFrontmatterCompletionSource({
  labels: ["architecture", "platform", "needs:quotes"],
  people: [
    { displayName: "Ada Lovelace", email: "ada@example.com", id: "ada@example.com" },
    { displayName: "Grace Hopper", email: "grace@example.com", id: "grace@example.com" },
  ],
  states: ["under-review"],
});

test("frontmatter completion offers missing fields", async () => {
  const result = await complete("---\nstate: draft\n|\n---\nBody");

  assert.deepEqual(
    result?.options.map((option) => option.label),
    ["authors", "visibility", "labels"],
  );
});

test("frontmatter completion offers visibility and workspace state values", async () => {
  const state = await complete("---\nstate: a|\n---\nBody");
  assert.ok(state?.options.some((option) => option.label === "accepted"));
  assert.ok(state?.options.some((option) => option.label === "abandoned"));
  assert.ok(state?.options.some((option) => option.label === "under-review"));

  const visibility = await complete("---\nvisibility: |\n---\nBody");
  assert.deepEqual(
    visibility?.options.map((option) => option.label),
    ["public", "private", "confidential"],
  );
});

test("frontmatter completion offers known labels in block and flow lists", async () => {
  const block = await complete("---\nlabels:\n  - pla|\n---\nBody");
  assert.deepEqual(
    block?.options.map((option) => option.label),
    ["architecture", "platform", "needs:quotes"],
  );
  assert.equal(block?.options.find((option) => option.label === "platform")?.apply, "platform");
  assert.equal(
    block?.options.find((option) => option.label === "needs:quotes")?.apply,
    '"needs:quotes"',
  );

  const flow = await complete("---\nlabels: [architecture, pla|]\n---\nBody");
  assert.equal(flow?.from, "---\nlabels: [architecture, ".length);
  assert.equal(flow?.to, "---\nlabels: [architecture, pla".length);
});

test("frontmatter completion offers known author email addresses", async () => {
  const block = await complete("---\nauthors:\n  - ad|\n---\nBody");
  assert.deepEqual(
    block?.options.map((option) => option.label),
    ["ada@example.com", "grace@example.com"],
  );
  assert.equal(block?.options[0]?.detail, "Ada Lovelace");

  const flow = await complete("---\nauthors: [grace@example.com, ad|]\n---\nBody");
  assert.equal(flow?.from, "---\nauthors: [grace@example.com, ".length);
});

test("frontmatter completion stays out of Markdown content", async () => {
  assert.equal(await complete("---\nstate: draft\n---\n# pla|"), null);
  assert.equal(await complete("# state: a|"), null);
});

async function complete(sourceText: string) {
  const cursor = sourceText.indexOf("|");
  assert.notEqual(cursor, -1);
  const state = EditorState.create({ doc: sourceText.replace("|", "") });
  return await source(new CompletionContext(state, cursor, true));
}
