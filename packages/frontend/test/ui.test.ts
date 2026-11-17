import assert from "node:assert/strict";
import test from "node:test";

import { colorFor, documentExportFileName, documentHref, publicDocumentHref } from "../src/ui.ts";

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

test("exported files are named after the document", () => {
  assert.equal(
    documentExportFileName("Export Demo: Café & Ünïcode", 42, "pdf"),
    "rfc-0042-export-demo-cafe-unicode.pdf",
  );
  assert.equal(documentExportFileName("Meeting notes", undefined, "docx"), "meeting-notes.docx");
  assert.equal(documentExportFileName("???", undefined, "docx"), "document.docx");
});
