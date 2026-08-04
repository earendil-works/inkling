export type {
  AcceptedBodyUpdate,
  AuthorityError,
  AuthorityEvent,
  DocumentAuthorityService,
  DocumentSnapshot,
  MakeDocumentAuthorityOptions,
} from "./authority.ts";
export {
  DocumentAuthority,
  loadDocumentRevision,
  makeDocumentAuthority,
  RecoveryError,
} from "./authority.ts";
export type { ResolvedAnchor } from "./anchors.ts";
export { createCommentAnchor, reanchorAfterReplacement, resolveCommentAnchor } from "./anchors.ts";
export { BinaryEncodingError, decodeBase64, encodeBase64 } from "./binary.ts";
export type { CollaborativeDocument } from "./document.ts";
export {
  applyDocumentUpdate,
  bodyTextName,
  cloneDocument,
  CollaborationError,
  createCollaborativeDocument,
  createCollaborativeDocumentScoped,
  destroyCollaborativeDocument,
  encodeDocumentState,
  encodeMissingState,
  encodeStateVector,
  replaceDocumentBody,
} from "./document.ts";
