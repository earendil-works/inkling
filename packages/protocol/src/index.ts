export const protocolVersion = 1;

export interface HealthResponse {
  readonly service: "jot";
  readonly status: "ok";
  readonly version: string;
  readonly protocolVersion: number;
}

export interface ProtocolError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export interface BodyUpdateMessage {
  readonly type: "body-update";
  readonly clientUpdateId: string;
  readonly update: Uint8Array;
}

export interface AcceptedUpdateMessage {
  readonly type: "update-accepted";
  readonly clientUpdateId: string;
  readonly serverSequence: number;
  readonly documentRevision: number;
}

export interface PermissionChangedMessage {
  readonly type: "permission-changed";
  readonly actions: readonly string[];
}

export interface ResynchronizeMessage {
  readonly type: "resynchronize";
  readonly reason: string;
}

export type ClientCollaborationMessage = BodyUpdateMessage;
export type ServerCollaborationMessage =
  | AcceptedUpdateMessage
  | PermissionChangedMessage
  | ResynchronizeMessage;
