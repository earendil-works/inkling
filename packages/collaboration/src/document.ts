import { Data, Effect, type Scope } from "effect";
import * as Y from "yjs";

export const bodyTextName = "body";

export interface CollaborativeDocument {
  readonly document: Y.Doc;
  readonly body: Y.Text;
}

export class CollaborationError extends Data.TaggedError("CollaborationError")<{
  readonly code: "invalid_anchor" | "invalid_update";
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** Create the shared Yjs shape used by browser and server authorities. */
export function createCollaborativeDocument(): Effect.Effect<CollaborativeDocument> {
  return Effect.sync(() => {
    const document = new Y.Doc();
    return { body: document.getText(bodyTextName), document };
  });
}

export function createCollaborativeDocumentScoped(): Effect.Effect<
  CollaborativeDocument,
  never,
  Scope.Scope
> {
  return Effect.acquireRelease(createCollaborativeDocument(), destroyCollaborativeDocument);
}

export function destroyCollaborativeDocument(value: CollaborativeDocument): Effect.Effect<void> {
  return Effect.sync(() => value.document.destroy());
}

export function encodeDocumentState(document: Y.Doc): Effect.Effect<Uint8Array> {
  return Effect.sync(() => Y.encodeStateAsUpdate(document));
}

export function encodeMissingState(
  document: Y.Doc,
  remoteStateVector: Uint8Array,
): Effect.Effect<Uint8Array, CollaborationError> {
  return Effect.try({
    catch: (cause) =>
      new CollaborationError({
        code: "invalid_update",
        message: "The state vector is invalid.",
        cause,
      }),
    try: () => Y.encodeStateAsUpdate(document, remoteStateVector),
  });
}

export function encodeStateVector(document: Y.Doc): Effect.Effect<Uint8Array> {
  return Effect.sync(() => Y.encodeStateVector(document));
}

export function applyDocumentUpdate(
  document: Y.Doc,
  update: Uint8Array,
): Effect.Effect<void, CollaborationError> {
  return Effect.try({
    catch: (cause) =>
      new CollaborationError({
        code: "invalid_update",
        message: "The Yjs update is invalid.",
        cause,
      }),
    try: () => Y.applyUpdate(document, update),
  });
}

export function replaceDocumentBody(
  collaborative: CollaborativeDocument,
  body: string,
): Effect.Effect<Uint8Array> {
  return Effect.sync(() => {
    const before = Y.encodeStateVector(collaborative.document);
    collaborative.document.transact(() => {
      collaborative.body.delete(0, collaborative.body.length);
      collaborative.body.insert(0, body);
    });
    return Y.encodeStateAsUpdate(collaborative.document, before);
  });
}

export function cloneDocument(document: Y.Doc): Effect.Effect<Y.Doc, CollaborationError> {
  return Effect.gen(function* () {
    const update = yield* encodeDocumentState(document);
    const cloned = new Y.Doc();
    yield* applyDocumentUpdate(cloned, update);
    return cloned;
  });
}
