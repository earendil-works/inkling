import * as Y from "yjs";

export const bodyTextName = "body";

export interface CollaborativeDocument {
  readonly document: Y.Doc;
  readonly body: Y.Text;
}

/** Create the shared Yjs shape used by browser and server authorities. */
export function createCollaborativeDocument(): CollaborativeDocument {
  const document = new Y.Doc();
  const body = document.getText(bodyTextName);

  return { body, document };
}

export function encodeDocumentState(document: Y.Doc): Uint8Array {
  return Y.encodeStateAsUpdate(document);
}

export function encodeMissingState(document: Y.Doc, remoteStateVector: Uint8Array): Uint8Array {
  return Y.encodeStateAsUpdate(document, remoteStateVector);
}

export function encodeStateVector(document: Y.Doc): Uint8Array {
  return Y.encodeStateVector(document);
}

export function applyDocumentUpdate(document: Y.Doc, update: Uint8Array): void {
  Y.applyUpdate(document, update);
}
