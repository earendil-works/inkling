import assert from "node:assert/strict";
import test from "node:test";

import type { DocumentMetadataDto } from "@earendil-works/inkling-protocol";

import { metadataWithFrontmatter } from "../src/components/document-metadata.ts";

const metadata: DocumentMetadataDto = {
  approvers: [],
  authors: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  headRevision: 1,
  id: "document_123",
  labels: [],
  lifecycleState: "draft",
  relatedDocuments: [],
  reviewers: [],
  sharing: { access: "disabled", generation: 0 },
  title: "Title",
  updatedAt: "2026-01-01T00:00:00.000Z",
  visibility: "private",
};

test("frontmatter visibility directly previews public, private, or confidential state", () => {
  assert.equal(
    metadataWithFrontmatter(metadata, { visibility: "confidential" }).visibility,
    "confidential",
  );
  assert.equal(metadataWithFrontmatter(metadata, { visibility: "public" }).visibility, "public");
});

test("frontmatter authors render known account names and retain email identity", () => {
  const rendered = metadataWithFrontmatter(
    metadata,
    { authors: ["ada@example.com", "unknown@example.com"] },
    undefined,
    [{ displayName: "Ada Lovelace", email: "ada@example.com", id: "account_ada" }],
  );

  assert.deepEqual(rendered.authors, [
    { displayName: "Ada Lovelace", email: "ada@example.com", id: "ada@example.com" },
    {
      displayName: "unknown@example.com",
      email: "unknown@example.com",
      id: "unknown@example.com",
    },
  ]);
});
