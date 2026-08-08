import assert from "node:assert/strict";
import test from "node:test";

import { Effect } from "effect";

import {
  importEarendilRfc,
  importExistingJot,
  rewriteKnownRfcSourceLinks,
  rewriteLegacyRfcLinks,
} from "../src/index.ts";

test("Earendil RFC import preserves structured metadata and unknown states", async () => {
  const imported = await Effect.runPromise(
    importEarendilRfc(
      `---
rfc: 42
title: Durable collaboration
authors: [Armin, alice@example.com]
reviewers: Bob
state: needs-council
visibility: public
confidential: false
keywords: [architecture, collaboration]
created: 2024-01-02
updated: 2024-03-04
target_decision_date: 2024-04-01
related_rfcs: [RFC 12, 13]
source_url: https://legacy.example/rfc/42
---
# RFC 0042 Durable collaboration

See [the prior decision](../rfcs/0012-prior.md#outcome).
`,
      {
        people: [
          {
            aliases: ["Armin"],
            displayName: "Armin Ronacher",
            email: "armin@ronacher.eu",
          },
          {
            aliases: ["Bob"],
            displayName: "Robert Reviewer",
            email: "bob@example.com",
          },
        ],
        sourcePath: "rfcs/0042-durable.md",
      },
    ),
  );

  assert.equal(imported.metadata.rfcNumber, 42);
  assert.equal(imported.metadata.lifecycleState, "needs-council");
  assert.equal(imported.metadata.visibility, "public");
  assert.deepEqual(imported.metadata.labels, ["architecture", "collaboration"]);
  assert.equal(imported.metadata.authors?.[0]?.displayName, "Armin Ronacher");
  assert.equal(imported.metadata.reviewers?.[0]?.displayName, "Robert Reviewer");
  assert.deepEqual(imported.relatedRfcNumbers, [12, 13]);
  assert.equal(imported.metadata.title, "Durable collaboration");
  assert.equal(imported.body.startsWith("# Durable collaboration"), true);
  assert.match(imported.body, /\/rfcs\/0012#outcome/u);
});

test("legacy Jot import keeps share and comment migration data", async () => {
  const imported = await Effect.runPromise(
    importExistingJot(
      "---\nignored: frontmatter\n---\nBody text",
      {
        comments: [
          {
            end: 4,
            id: "old-thread",
            messages: [{ author: "Armin", body: "Comment", id: "old-message" }],
            quote: "Body",
            resolved: true,
            start: 0,
          },
        ],
        id: "document_legacy123",
        shareAccess: "comment",
        shareId: "legacy-share",
        title: "Imported note",
      },
      { sourcePath: "notes/imported.md" },
    ),
  );
  assert.equal(imported.body, "# Imported note\n\nBody text");
  assert.equal(imported.capabilityAccess, "comment");
  assert.equal(imported.comments[0]?.messages[0]?.legacyId, "old-message");
  assert.equal(imported.comments[0]?.resolved, true);
});

test("Earendil people entries use canonical emails and names", async () => {
  const imported = await Effect.runPromise(
    importEarendilRfc(
      `---
number: 9
authors:
  - Armin <alias@example.com>
  - unknown@example.com
---
# RFC 0009 People
`,
      {
        people: [
          {
            aliases: ["alias@example.com"],
            displayName: "Armin Ronacher",
            email: "armin@example.com",
          },
        ],
        sourcePath: "rfcs/0009.md",
      },
    ),
  );

  assert.deepEqual(
    imported.metadata.authors?.map(({ displayName, email }) => ({ displayName, email })),
    [
      { displayName: "Armin Ronacher", email: "armin@example.com" },
      { displayName: "unknown@example.com", email: "unknown@example.com" },
    ],
  );
});

test("legacy RFC link rewriting leaves external links unchanged", () => {
  assert.equal(
    rewriteLegacyRfcLinks(
      "[relative](rfc-7-title.md) [old site](http://rfcs/0012.md) [external](https://example.com/7.md)",
    ),
    "[relative](/rfcs/0007) [old site](/rfcs/0012) [external](https://example.com/7.md)",
  );
});

test("known legacy source links become canonical RFC links", () => {
  const source = "https://docs.google.com/document/d/legacy-id/edit";
  assert.equal(
    rewriteKnownRfcSourceLinks(
      `[prior](${source}?tab=t.0#heading=h.old) [external](https://example.com/)`,
      [{ legacySourceUrl: source, rfcNumber: 7 }],
    ),
    "[prior](/rfcs/0007) [external](https://example.com/)",
  );
});
