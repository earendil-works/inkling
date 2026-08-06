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

test("interactive rendering annotates block elements with Markdown source ranges", async () => {
  const markdown = "# Heading\n\nParagraph with **strong text**.\n\n- list item\n";
  const rendered = await Effect.runPromise(renderer.render(markdown, { sourcePositions: true }));
  assert.match(
    rendered.html,
    /<h1 id="heading" data-jot-source-start="0" data-jot-source-end="10"/u,
  );
  assert.match(rendered.html, /<p data-jot-source-start="11" data-jot-source-end="43"/u);
  assert.match(rendered.html, /data-jot-source-kind="list_item"/u);

  const published = await Effect.runPromise(renderer.render(markdown));
  assert.doesNotMatch(published.html, /data-jot-source/u);
});

test("fenced code is syntax highlighted with language metadata", async () => {
  const rendered = await Effect.runPromise(
    renderer.render("```ts\nconst value: number = 1;\n```", { sourcePositions: true }),
  );
  assert.match(
    rendered.html,
    /<pre class="jot-code" data-jot-source-start="0" data-jot-source-end="34"/u,
  );
  assert.match(rendered.html, /<code class="jot-syntax language-ts">/u);
  assert.match(rendered.html, /<span class="tok-keyword">const<\/span>/u);
  assert.match(rendered.html, /<span class="tok-typeName">number<\/span>/u);
});

test("unknown fenced languages remain escaped", async () => {
  const rendered = await Effect.runPromise(
    renderer.render("```not-a-language\n<script>alert(1)</script>\n```"),
  );
  assert.match(rendered.html, /<code class="language-not-a-language">/u);
  assert.match(rendered.html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/u);
  assert.doesNotMatch(rendered.html, /<script>/u);
});

test("oversized Mermaid input is rejected without an interactive placeholder", async () => {
  const rendered = await Effect.runPromise(
    renderer.render(`\`\`\`mermaid\n${"x".repeat(100_001)}\n\`\`\``),
  );
  assert.match(rendered.html, /exceeds the 100 KB render limit/u);
  assert.doesNotMatch(rendered.html, /data-mermaid/u);
});
