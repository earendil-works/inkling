import assert from "node:assert/strict";
import test from "node:test";

import {
  applyDocumentUpdate,
  createCollaborativeDocument,
  encodeDocumentState,
} from "../src/index.ts";

test("concurrent clients converge after exchanging Yjs updates", () => {
  const left = createCollaborativeDocument();
  const right = createCollaborativeDocument();

  left.body.insert(0, "alpha");
  right.body.insert(0, "beta");

  const leftUpdate = encodeDocumentState(left.document);
  const rightUpdate = encodeDocumentState(right.document);

  applyDocumentUpdate(left.document, rightUpdate);
  applyDocumentUpdate(right.document, leftUpdate);

  assert.equal(left.body.toString(), right.body.toString());

  left.document.destroy();
  right.document.destroy();
});
