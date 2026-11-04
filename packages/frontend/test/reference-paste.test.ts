import assert from "node:assert/strict";
import test from "node:test";

import { pastedReferenceMarkdown, referenceForPastedUrl } from "../src/reference-paste.ts";

const origin = "https://rfc.example.com";
const current = { documentId: "doc_current0001", rfcNumber: 74 };

test("pasted links to sections of this workspace become references", () => {
  assert.deepEqual(referenceForPastedUrl(`${origin}/rfc/0057#motivation`, origin, current), {
    destination: "rfc:57#motivation",
    self: false,
  });
  assert.deepEqual(referenceForPastedUrl(` ${origin}/rfc/0057/edit `, origin, current), {
    destination: "rfc:57",
    self: false,
  });
  assert.deepEqual(
    referenceForPastedUrl(`${origin}/documents/doc_abcdefghij#hidden-notes`, origin, current),
    { destination: "doc:doc_abcdefghij#hidden-notes", self: false },
  );
  assert.deepEqual(referenceForPastedUrl(`${origin}/rfc/0074#scope`, origin, current), {
    destination: "#scope",
    self: true,
  });
});

test("other links stay links", () => {
  for (const text of [
    "https://elsewhere.example/rfc/0057#motivation",
    `${origin}/share/doc_abcdefghij?cap=secret`,
    `${origin}/rfc/0057#not a valid anchor`,
    `${origin}/rfc/0057 and more text`,
    "rfc:57",
  ]) {
    assert.equal(referenceForPastedUrl(text, origin, current), undefined, text);
  }
});

test("references paste as autolinks, keep selected text, and complete link destinations", () => {
  const reference = { destination: "rfc:57#motivation", self: false };
  assert.equal(pastedReferenceMarkdown(reference, "", "x "), "<rfc:57#motivation>");
  assert.equal(
    pastedReferenceMarkdown(reference, "the reasons", "x "),
    "[the reasons](rfc:57#motivation)",
  );
  assert.equal(pastedReferenceMarkdown(reference, "", "]("), "rfc:57#motivation");
  assert.equal(
    pastedReferenceMarkdown({ destination: "#scope", self: true }, "", ""),
    "[](#scope)",
  );
});
