import assert from "node:assert/strict";
import test from "node:test";

import { Effect } from "effect";

import { importEarendilRfc, importExistingJot, rewriteLegacyRfcLinks } from "../src/index.ts";

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
# Durable collaboration

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
  assert.equal(imported.body.startsWith("# Durable collaboration"), false);
  assert.match(imported.body, /\/rfc\/0012#outcome/u);
});

test("existing Jot import keeps share and comment migration data", async () => {
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
  assert.equal(imported.body, "Body text");
  assert.equal(imported.capabilityAccess, "comment");
  assert.equal(imported.comments[0]?.messages[0]?.legacyId, "old-message");
  assert.equal(imported.comments[0]?.resolved, true);
});

test("legacy RFC link rewriting leaves external links unchanged", () => {
  assert.equal(
    rewriteLegacyRfcLinks("[internal](rfc-7-title.md) [external](https://example.com/7.md)"),
    "[internal](/rfc/0007) [external](https://example.com/7.md)",
  );
});
