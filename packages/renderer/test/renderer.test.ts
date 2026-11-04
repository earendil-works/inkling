import assert from "node:assert/strict";
import test from "node:test";

import { Effect } from "effect";

import {
  collectReferences,
  makeMarkdownRenderer,
  outlineDocument,
  redactReferences,
  serializeDocumentFrontmatter,
} from "../src/index.ts";

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

test("protected external links use an opaque href without changing other query bytes", async () => {
  const rendered = await Effect.runPromise(
    renderer.render(
      "[recording](https://videos.example/watch?signature=a%2Bb&__require_auth=1&part=2#chapter)",
      { protectedLinkHref: ({ index }) => `/auth/link/doc_example/7/${index}` },
    ),
  );

  assert.deepEqual(rendered.protectedLinks, [
    {
      destination: "https://videos.example/watch?signature=a%2Bb&part=2#chapter",
      index: 0,
      source: "https://videos.example/watch?signature=a%2Bb&__require_auth=1&part=2#chapter",
    },
  ]);
  assert.match(rendered.html, /href="\/auth\/link\/doc_example\/7\/0"/u);
  assert.doesNotMatch(rendered.html, /videos\.example|signature/u);
  assert.match(rendered.html, /target="_blank"/u);

  const ordinary = await Effect.runPromise(
    renderer.render("[ordinary](https://example.com/?require_auth=1)"),
  );
  assert.deepEqual(ordinary.protectedLinks, []);
  assert.match(ordinary.html, /require_auth=1/u);
});

test("malformed or non-external protected link directives fail closed", async () => {
  const failures = await Promise.all(
    [
      "[wrong value](https://example.com/?__require_auth=true)",
      "[duplicate](https://example.com/?__require_auth=1&__require_auth=1)",
      "[relative](/internal?__require_auth=1)",
      "![image](https://example.com/image.png?__require_auth=1)",
      "[invalid](https://?__require_auth=1)",
    ].map((markdown) => Effect.runPromise(Effect.flip(renderer.render(markdown)))),
  );
  for (const failure of failures) assert.match(failure.message, /__require_auth/u);
});

test("frontmatter is parsed without entering rendered content", async () => {
  const source =
    "---\nstate: discussion\nvisibility: public\nlabels:\n  - architecture\n  - platform\n---\n## Decision\n\nBody";
  const rendered = await Effect.runPromise(renderer.render(source, { sourcePositions: true }));
  assert.deepEqual(rendered.frontmatter, {
    authors: undefined,
    labels: ["architecture", "platform"],
    state: "discussion",
    visibility: "public",
  });
  assert.doesNotMatch(rendered.html, /visibility/u);
  assert.match(rendered.html, /<h2 id="decision" data-inkling-source-start="\d+"/u);
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
      state: "draft",
      visibility: "private",
    }),
    /authors:\n  - ada@example\.com/u,
  );
});

test("legacy sensitivity and workspace visibility normalize into visibility", async () => {
  const rendered = await Effect.runPromise(
    renderer.render(
      "---\nvisibility: workspace\nsensitivity: confidential\n---\n# Legacy document",
    ),
  );
  assert.equal(rendered.frontmatter?.visibility, "confidential");
  assert.equal("sensitivity" in (rendered.frontmatter ?? {}), false);
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

test("table-of-contents headings use rendered text without Markdown escapes", async () => {
  const rendered = await Effect.runPromise(
    renderer.render("## Detailed plan\n\n### 1\\. Home\n\n### Escaped \\*label\\*"),
  );
  assert.deepEqual(
    rendered.headings.map((heading) => heading.text),
    ["Detailed plan", "1. Home", "Escaped *label*"],
  );
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

test("RFC headings are numbered by nesting, and notes are not", async () => {
  const markdown =
    "# Title\n\n## Summary\n\n## Design\n\n### Storage\n\n#### Keys\n\n### Wire\n\n## Rollout\n\n#### Skipped level";
  const rfc = await Effect.runPromise(renderer.render(markdown, { numberHeadings: true }));
  assert.deepEqual(
    rfc.headings.map((heading) => `${heading.number ?? ""} ${heading.text}`),
    [
      "1 Summary",
      "2 Design",
      "2.1 Storage",
      "2.1.1 Keys",
      "2.2 Wire",
      "3 Rollout",
      "3.1 Skipped level",
    ],
  );
  assert.match(
    rfc.html,
    /<h3 id="storage"><span class="inkling-section-number">2\.1<\/span> Storage <a class="inkling-heading-anchor" href="#storage"/u,
  );

  const note = await Effect.runPromise(renderer.render(markdown));
  assert.equal(
    note.headings.every((heading) => heading.number === undefined),
    true,
  );
  assert.doesNotMatch(note.html, /inkling-section-number/u);
});

test("headings can pin their ID", async () => {
  const rendered = await Effect.runPromise(
    renderer.render("## Why we do this {#motivation}\n\nSee [](#motivation)."),
  );
  assert.deepEqual(rendered.headings, [{ depth: 2, id: "motivation", text: "Why we do this" }]);
  assert.match(rendered.html, /<h2 id="motivation">Why we do this <a/u);
  assert.match(
    rendered.html,
    /<a href="#motivation" class="inkling-reference"[^>]*>Why we do this<\/a>/u,
  );
});

test("references fill in the resolved target and section", async () => {
  const markdown = [
    "# Title",
    "",
    "## Scope",
    "",
    "- <rfc:57#motivation>",
    "- [](rfc:0057)",
    "- [the reasons](rfc:57#motivation)",
    "- <doc:doc_abcdefghij#notes>",
    "- <rfc:58#secret-plan>",
    "- <rfc:57#gone>",
    "- [](#scope)",
    "- <rfc:59>",
  ].join("\n");
  const rendered = await Effect.runPromise(
    renderer.render(markdown, {
      numberHeadings: true,
      references: new Map([
        [
          "rfc:57#motivation",
          {
            href: "/rfc/0057",
            rfcNumber: 57,
            section: { id: "motivation", number: "3.2", text: "Motivation" },
            status: "available",
            title: "Storage",
          },
        ],
        [
          "rfc:57",
          {
            href: "/rfc/0057",
            rfcNumber: 57,
            status: "available",
            title: "Storage",
          },
        ],
        [
          "doc:doc_abcdefghij#notes",
          {
            href: "/documents/doc_abcdefghij",
            section: { id: "notes", text: "Notes" },
            status: "available",
            title: "Meeting",
          },
        ],
        ["rfc:58#secret-plan", { status: "unavailable" }],
        [
          "rfc:57#gone",
          {
            href: "/rfc/0057",
            rfcNumber: 57,
            status: "available",
            title: "Storage",
          },
        ],
      ]),
      unavailableReferenceHref: ({ index }) => `/auth/reference/doc_source/3/${index}`,
    }),
  );
  assert.deepEqual(
    rendered.references.map(({ index, key }) => `${index}:${key}`),
    [
      "0:rfc:57#motivation",
      "1:rfc:57",
      "2:rfc:57#motivation",
      "3:doc:doc_abcdefghij#notes",
      "4:rfc:58#secret-plan",
      "5:rfc:57#gone",
      "6:rfc:59",
    ],
  );
  assert.match(rendered.html, /href="\/rfc\/0057#motivation"[^>]*>RFC 0057 §3\.2 Motivation<\/a>/u);
  assert.match(rendered.html, /href="\/rfc\/0057"[^>]*>RFC 0057: Storage<\/a>/u);
  assert.match(
    rendered.html,
    /href="\/rfc\/0057#motivation"[^>]*title="RFC 0057 §3\.2 Motivation">the reasons<\/a>/u,
  );
  assert.match(
    rendered.html,
    /href="\/documents\/doc_abcdefghij#notes"[^>]*>Meeting › Notes<\/a>/u,
  );
  assert.match(
    rendered.html,
    /href="\/auth\/reference\/doc_source\/3\/4"[^>]*>RFC 0058 \(unavailable\)<\/a>/u,
  );
  assert.doesNotMatch(rendered.html, /secret-plan/u);
  assert.match(
    rendered.html,
    /data-reference-status="missing"[^>]*>RFC 0057 \(missing section #gone\)/u,
  );
  assert.match(rendered.html, /href="#scope"[^>]*>§1 Scope<\/a>/u);
  assert.match(
    rendered.html,
    /href="\/rfc\/0059"[^>]*data-reference-status="pending">RFC 0059<\/a>/u,
  );

  const collected = await Effect.runPromise(collectReferences(markdown));
  assert.deepEqual(
    collected.map(({ index, key }) => `${index}:${key}`),
    rendered.references.map(({ index, key }) => `${index}:${key}`),
  );
});

test("outlines match the rendered headings", async () => {
  const markdown = "---\nstate: draft\n---\n# Title\n\n## One {#first}\n\n### Two\n\n## One";
  const outline = await Effect.runPromise(outlineDocument(markdown, { numberHeadings: true }));
  const rendered = await Effect.runPromise(renderer.render(markdown, { numberHeadings: true }));
  assert.equal(outline.title, "Title");
  assert.deepEqual(outline.headings, rendered.headings);
  assert.deepEqual(
    outline.headings.map(({ id, number }) => `${number ?? ""}:${id}`),
    ["1:first", "1.1:two", "2:one"],
  );
});

test("legacy relative RFC links are canonical while IETF RFC links stay external", async () => {
  const rendered = await Effect.runPromise(
    renderer.render(
      "[a](rfc-57.md#scope) [b](../rfcs/57) [c](https://datatracker.ietf.org/doc/html/rfc9110#section-5) [d](https://www.rfc-editor.org/rfc/rfc9110)",
    ),
  );
  assert.match(rendered.html, /href="\/rfc\/0057#scope"/u);
  assert.match(rendered.html, /href="\/rfc\/0057"/u);
  assert.match(
    rendered.html,
    /href="https:\/\/datatracker\.ietf\.org\/doc\/html\/rfc9110#section-5"/u,
  );
  assert.match(rendered.html, /href="https:\/\/www\.rfc-editor\.org\/rfc\/rfc9110"/u);
});

test("anonymous bodies hide sections of references they cannot open", () => {
  const body = [
    "<rfc:57#public-part> <rfc:58#secret-plan> [](rfc:58#secret-plan) [text](rfc:58#secret-plan)",
    "`rfc:58#secret-plan` <rfc:58> rfc:58 [](doc:doc_abcdefghij#hidden)",
  ].join("\n");
  const redacted = redactReferences(body, {
    available: (reference) => reference.key.startsWith("rfc:57"),
    redirect: (reference) =>
      reference.key === "rfc:58#secret-plan" ? "/auth/reference/doc_source/3/1" : undefined,
  });
  assert.equal(
    redacted,
    [
      "<rfc:57#public-part> [RFC 0058 (unavailable)](/auth/reference/doc_source/3/1) [RFC 0058 (unavailable)](/auth/reference/doc_source/3/1) [text](/auth/reference/doc_source/3/1)",
      "`/auth/reference/doc_source/3/1` [RFC 0058 (unavailable)](rfc:58) rfc:58 [Unavailable document](doc:doc_abcdefghij)",
    ].join("\n"),
  );
  assert.doesNotMatch(redacted, /secret|hidden/u);
});
