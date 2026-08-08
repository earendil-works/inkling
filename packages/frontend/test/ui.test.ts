import assert from "node:assert/strict";
import test from "node:test";

import { colorFor, documentHref, publicDocumentHref } from "../src/ui.ts";

test("RFC document links use canonical number routes", () => {
  assert.equal(documentHref("doc_example123", 42, false, "read", ""), "/rfcs/0042");
  assert.equal(documentHref("doc_example123", 42, false, "edit", ""), "/rfcs/0042/edit");
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
  assert.equal(publicDocumentHref("doc_example123", 42), "/rfcs/0042");
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
