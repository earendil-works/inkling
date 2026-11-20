import assert from "node:assert/strict";
import test from "node:test";

import {
  colorFor,
  documentHref,
  isWikiDocument,
  isWikiPage,
  publicDocumentHref,
} from "../src/ui.ts";

test("RFC document links use canonical number routes", () => {
  assert.equal(documentHref("doc_example123", 42, false, "read", ""), "/rfc/0042");
  assert.equal(documentHref("doc_example123", 42, false, "edit", ""), "/rfc/0042/edit");
  assert.equal(
    documentHref("doc_example123", undefined, false, "read", ""),
    "/documents/doc_example123",
  );
  assert.equal(
    documentHref("doc_example123", 42, true, "edit", "?cap=secret"),
    "/share/doc_example123/edit?cap=secret",
  );
});

test("public document links use anonymous published routes", () => {
  assert.equal(publicDocumentHref("doc_example123", 42), "/rfc/0042");
  assert.equal(publicDocumentHref("doc_example123", undefined), "/public/documents/doc_example123");
});

test("participant colors are stable and use perceptual OKLCH values", () => {
  const first = colorFor("person_armin");
  const second = colorFor("person_colin");

  assert.equal(first, colorFor("person_armin"));
  assert.match(first, /^oklch\(68% 0\.16 \d+(?:\.\d+)?\)$/u);
  assert.match(second, /^oklch\(68% 0\.16 \d+(?:\.\d+)?\)$/u);
  assert.notEqual(first, second);
});

test("notes labelled wiki are wiki pages below the wiki index", () => {
  assert.equal(isWikiPage({ labels: ["team", "wiki"] }), true);
  assert.equal(isWikiPage({ labels: ["team"] }), false);
  assert.equal(isWikiPage({ labels: ["wiki"], rfcNumber: 42 }), false);
  assert.equal(isWikiPage({ labels: ["wiki", "wiki-index"] }), false);
  // The index and wiki pages read with the wiki's navigation; RFCs and other notes don't.
  assert.equal(isWikiDocument({ labels: ["wiki-index"] }), true);
  assert.equal(isWikiDocument({ labels: ["wiki"] }), true);
  assert.equal(isWikiDocument({ labels: ["wiki"], rfcNumber: 42 }), false);
  assert.equal(isWikiDocument({ labels: ["team"] }), false);
});
