import assert from "node:assert/strict";
import test from "node:test";

import { Effect } from "effect";

import { makeMarkdownRenderer } from "../src/index.ts";

const renderer = makeMarkdownRenderer();

test("rendering disables raw HTML and dangerous URLs", async () => {
  const rendered = await Effect.runPromise(
    renderer.render(
      '<script>alert("x")</script>\n\n[bad](javascript:alert(1))\n\n[good](https://example.com)',
    ),
  );
  assert.doesNotMatch(rendered.html, /<script/u);
  assert.doesNotMatch(rendered.html, /href="javascript:/u);
  assert.match(rendered.html, /rel="noopener noreferrer"/u);
  assert.match(rendered.html, /target="_blank"/u);
});

test("headings are deterministic and duplicate-safe", async () => {
  const rendered = await Effect.runPromise(renderer.render("# Same\n\n## Same"));
  assert.deepEqual(rendered.headings, [
    { depth: 1, id: "same", text: "Same" },
    { depth: 2, id: "same-2", text: "Same" },
  ]);
  assert.match(rendered.html, /id="same-2"/u);
});

test("oversized Mermaid input is rejected without an interactive placeholder", async () => {
  const rendered = await Effect.runPromise(
    renderer.render(`\`\`\`mermaid\n${"x".repeat(100_001)}\n\`\`\``),
  );
  assert.match(rendered.html, /exceeds the 100 KB render limit/u);
  assert.doesNotMatch(rendered.html, /data-mermaid/u);
});
