import assert from "node:assert/strict";
import test from "node:test";

import { Effect } from "effect";

import { makeMarkdownRenderer, serializeDocumentFrontmatter } from "../src/index.ts";

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

test("frontmatter is parsed without entering rendered content", async () => {
  const source =
    "---\nstate: discussion\nvisibility: public\nsensitivity: normal\nlabels:\n  - architecture\n  - platform\n---\n## Decision\n\nBody";
  const rendered = await Effect.runPromise(renderer.render(source, { sourcePositions: true }));
  assert.deepEqual(rendered.frontmatter, {
    authors: undefined,
    labels: ["architecture", "platform"],
    sensitivity: "normal",
    state: "discussion",
    visibility: "public",
  });
  assert.doesNotMatch(rendered.html, /visibility/u);
  assert.match(rendered.html, /<h2 id="decision" data-inkling-source-start="103"/u);
});

test("author frontmatter uses normalized email identifiers", async () => {
  const rendered = await Effect.runPromise(
    renderer.render(
      "---\nauthors: [Ada@Example.com, grace@example.com, ada@example.com]\n---\n# Title",
    ),
  );
  assert.deepEqual(rendered.frontmatter?.authors, ["ada@example.com", "grace@example.com"]);
  assert.match(
    serializeDocumentFrontmatter({
      authors: ["ada@example.com"],
      labels: [],
      sensitivity: "normal",
      state: "draft",
      visibility: "workspace",
    }),
    /authors:\n  - ada@example\.com/u,
  );
});

test("invalid frontmatter fails with a useful error", async () => {
  const visibilityError = await Effect.runPromise(
    Effect.flip(renderer.render("---\nvisibility: everyone\n---\nBody")),
  );
  assert.match(visibilityError.message, /visibility must be one of/u);

  const authorError = await Effect.runPromise(
    Effect.flip(renderer.render("---\nauthors: [not-an-email]\n---\nBody")),
  );
  assert.match(authorError.message, /valid email addresses/u);
});

test("the first top-level heading becomes the title instead of rendered body content", async () => {
  const rendered = await Effect.runPromise(renderer.render("# **Same** title\n\n## Same title"));
  assert.equal(rendered.title, "Same title");
  assert.deepEqual(rendered.headings, [{ depth: 2, id: "same-title", text: "Same title" }]);
  assert.doesNotMatch(rendered.html, /<h1/u);
  assert.match(rendered.html, /<h2 id="same-title"/u);
});

test("interactive rendering annotates block elements with Markdown source ranges", async () => {
  const markdown = "# Heading\n\nParagraph with **strong text**.\n\n- list item\n";
  const rendered = await Effect.runPromise(renderer.render(markdown, { sourcePositions: true }));
  assert.equal(rendered.title, "Heading");
  assert.doesNotMatch(rendered.html, /<h1/u);
  assert.match(rendered.html, /<p data-inkling-source-start="11" data-inkling-source-end="43"/u);
  assert.match(rendered.html, /data-inkling-source-kind="list_item"/u);

  const published = await Effect.runPromise(renderer.render(markdown));
  assert.doesNotMatch(published.html, /data-inkling-source/u);
});

test("fenced code is syntax highlighted with language metadata", async () => {
  const rendered = await Effect.runPromise(
    renderer.render("```ts\nconst value: number = 1;\n```", { sourcePositions: true }),
  );
  assert.match(
    rendered.html,
    /<pre class="inkling-code" data-inkling-source-start="0" data-inkling-source-end="34"/u,
  );
  assert.match(rendered.html, /<code class="inkling-syntax language-ts">/u);
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
