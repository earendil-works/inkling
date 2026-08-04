import assert from "node:assert/strict";
import test from "node:test";

import { Effect } from "effect";
import * as Y from "yjs";

import {
  applyDocumentUpdate,
  createCollaborativeDocument,
  createCommentAnchor,
  encodeDocumentState,
  encodeMissingState,
  encodeStateVector,
  reanchorAfterReplacement,
  resolveCommentAnchor,
} from "../src/index.ts";

test("relative comment anchors survive surrounding collaborative edits", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const collaborative = yield* createCollaborativeDocument();
      collaborative.body.insert(0, "hello world");
      const anchor = yield* createCommentAnchor(collaborative.body, 6, 11);
      collaborative.body.insert(0, "say ");
      const resolved = yield* resolveCommentAnchor(
        collaborative.document,
        collaborative.body,
        anchor,
      );
      assert.deepEqual(resolved, { end: 15, orphaned: false, start: 10 });
    }),
  );
});

test("destructive replacement orphans an ambiguous textual anchor", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const collaborative = yield* createCollaborativeDocument();
      collaborative.body.insert(0, "unique phrase");
      const anchor = yield* createCommentAnchor(collaborative.body, 0, 6);
      collaborative.body.delete(0, collaborative.body.length);
      collaborative.body.insert(0, "unique and unique");
      const replaced = yield* reanchorAfterReplacement(collaborative.body, anchor);
      assert.equal(replaced.orphaned, true);
    }),
  );
});

test("state vectors recover missing updates and duplicate delivery is harmless", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const authority = yield* createCollaborativeDocument();
      const reconnecting = yield* createCollaborativeDocument();
      authority.body.insert(0, "first");
      yield* applyDocumentUpdate(
        reconnecting.document,
        yield* encodeDocumentState(authority.document),
      );
      const reconnectingVector = yield* encodeStateVector(reconnecting.document);
      authority.body.insert(authority.body.length, " second");
      const missing = yield* encodeMissingState(authority.document, reconnectingVector);
      yield* applyDocumentUpdate(reconnecting.document, missing);
      yield* applyDocumentUpdate(reconnecting.document, missing);
      assert.equal(reconnecting.body.toString(), "first second");
    }),
  );
});

test("local undo does not remove a remote participant's edit", () => {
  const local = new Y.Doc();
  const remote = new Y.Doc();
  const localText = local.getText("body");
  const remoteText = remote.getText("body");
  const localOrigin = Symbol("local");
  const undo = new Y.UndoManager(localText, { trackedOrigins: new Set([localOrigin]) });

  local.transact(() => localText.insert(0, "local"), localOrigin);
  Y.applyUpdate(remote, Y.encodeStateAsUpdate(local));
  remoteText.insert(remoteText.length, " remote");
  Y.applyUpdate(local, Y.encodeStateAsUpdate(remote), "remote");
  undo.undo();

  assert.equal(localText.toString(), " remote");
});
