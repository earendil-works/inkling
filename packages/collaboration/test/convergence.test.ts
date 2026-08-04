import assert from "node:assert/strict";
import test from "node:test";

import { Effect } from "effect";

import {
  applyDocumentUpdate,
  createCollaborativeDocument,
  destroyCollaborativeDocument,
  encodeDocumentState,
} from "../src/index.ts";

test("concurrent clients converge after exchanging Yjs updates", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const left = yield* createCollaborativeDocument();
      const right = yield* createCollaborativeDocument();

      left.body.insert(0, "alpha");
      right.body.insert(0, "beta");

      const leftUpdate = yield* encodeDocumentState(left.document);
      const rightUpdate = yield* encodeDocumentState(right.document);

      yield* applyDocumentUpdate(left.document, rightUpdate);
      yield* applyDocumentUpdate(right.document, leftUpdate);

      assert.equal(left.body.toString(), right.body.toString());

      yield* destroyCollaborativeDocument(left);
      yield* destroyCollaborativeDocument(right);
    }),
  );
});
