import { Data, Effect } from "effect";

import { IdGenerator, SecretHasher, SecureToken } from "../application/ports.ts";
import type { StorageError } from "../application/ports.ts";
import type { PersonId } from "./document.ts";
import type { Principal, WorkspaceRole } from "./authorization.ts";

export interface SessionRecord {
  readonly id: string;
  readonly tokenHash: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly displayName?: string | undefined;
  readonly email?: string | undefined;
  readonly personId?: PersonId | undefined;
  readonly role?: WorkspaceRole | undefined;
}

export interface ApiKeyRecord {
  readonly id: string;
  readonly label: string;
  readonly tokenHash: string;
  readonly createdAt: string;
  /** Optional only while decoding legacy keys, which are invalid until recreated by a user. */
  readonly personId?: PersonId | undefined;
  readonly role?: WorkspaceRole | undefined;
  readonly displayName?: string | undefined;
  readonly lastUsedAt?: string | undefined;
  readonly revokedAt?: string | undefined;
}

export interface ApiKeyIdentity {
  readonly personId: PersonId;
  readonly role: WorkspaceRole;
  readonly displayName?: string | undefined;
}

export interface AuthenticationState {
  readonly sessions: readonly SessionRecord[];
  readonly apiKeys: readonly ApiKeyRecord[];
}

export interface CreatedSession {
  readonly state: AuthenticationState;
  readonly token: string;
  readonly expiresAt: string;
}

export interface WorkspaceIdentity {
  readonly displayName: string;
  readonly email: string;
  readonly personId: PersonId;
  readonly role: WorkspaceRole;
}

export interface CreatedApiKey {
  readonly state: AuthenticationState;
  readonly token: string;
  readonly record: ApiKeyRecord;
}

export class AuthenticationError extends Data.TaggedError("AuthenticationError")<{
  readonly code: "invalid_token";
  readonly message: string;
}> {}

export function emptyAuthenticationState(): AuthenticationState {
  return { apiKeys: [], sessions: [] };
}

export function authenticateSession(
  state: AuthenticationState,
  token: string,
  now: string,
): Effect.Effect<Principal, AuthenticationError | StorageError, typeof SecretHasher.Service> {
  return Effect.gen(function* () {
    const [id, secret, extra] = token.split(".");
    if (id === undefined || secret === undefined || extra !== undefined) {
      return yield* authenticationFailure("invalid_token", "The session token is invalid.");
    }
    const record = state.sessions.find((item) => item.id === id);
    if (record === undefined || Date.parse(record.expiresAt) <= Date.parse(now)) {
      return yield* authenticationFailure(
        "invalid_token",
        "The session token is invalid or expired.",
      );
    }
    const hasher = yield* SecretHasher;
    if (!(yield* hasher.verify(secret, record.tokenHash))) {
      return yield* authenticationFailure("invalid_token", "The session token is invalid.");
    }
    if (record.personId === undefined || !isWorkspaceRole(record.role)) {
      return yield* authenticationFailure("invalid_token", "The session token is invalid.");
    }
    return {
      displayName: record.displayName,
      kind: "workspace",
      personId: record.personId,
      role: record.role,
    };
  });
}

export function createWorkspaceSession(
  state: AuthenticationState,
  identity: WorkspaceIdentity,
  now: string,
  sessionLifetimeMilliseconds = 30 * 24 * 60 * 60 * 1000,
): Effect.Effect<
  CreatedSession,
  AuthenticationError | StorageError,
  typeof IdGenerator.Service | typeof SecretHasher.Service | typeof SecureToken.Service
> {
  return Effect.gen(function* () {
    const hasher = yield* SecretHasher;
    const ids = yield* IdGenerator;
    const tokens = yield* SecureToken;
    const id = yield* ids.generate("session");
    const secret = yield* tokens.generate(32);
    const tokenHash = yield* hasher.hash(secret);
    const expiresAt = new Date(Date.parse(now) + sessionLifetimeMilliseconds).toISOString();
    const record: SessionRecord = {
      createdAt: now,
      displayName: identity.displayName,
      email: identity.email,
      expiresAt,
      id,
      personId: identity.personId,
      role: identity.role,
      tokenHash,
    };
    return {
      expiresAt,
      state: {
        ...state,
        apiKeys: state.apiKeys.map((apiKey) =>
          apiKey.personId === identity.personId
            ? {
                ...apiKey,
                displayName: identity.displayName,
                role: identity.role,
              }
            : apiKey,
        ),
        sessions: [
          ...state.sessions.filter(
            (session) =>
              session.personId !== identity.personId &&
              Date.parse(session.expiresAt) > Date.parse(now),
          ),
          record,
        ],
      },
      token: `${id}.${secret}`,
    };
  });
}

export function logoutSession(state: AuthenticationState, token: string): AuthenticationState {
  const id = token.split(".")[0];
  return { ...state, sessions: state.sessions.filter((record) => record.id !== id) };
}

export function createApiKey(
  state: AuthenticationState,
  identity: ApiKeyIdentity,
  label: string,
  now: string,
): Effect.Effect<
  CreatedApiKey,
  AuthenticationError | StorageError,
  typeof IdGenerator.Service | typeof SecretHasher.Service | typeof SecureToken.Service
> {
  return Effect.gen(function* () {
    const normalizedLabel = label.trim();
    if (normalizedLabel.length === 0 || normalizedLabel.length > 200) {
      return yield* authenticationFailure("invalid_token", "API key labels must be non-empty.");
    }
    const hasher = yield* SecretHasher;
    const ids = yield* IdGenerator;
    const tokens = yield* SecureToken;
    const id = yield* ids.generate("key");
    const secret = yield* tokens.generate(32);
    const record: ApiKeyRecord = {
      createdAt: now,
      displayName: identity.displayName,
      id,
      label: normalizedLabel,
      personId: identity.personId,
      role: identity.role,
      tokenHash: yield* hasher.hash(secret),
    };
    return {
      record,
      state: { ...state, apiKeys: [...state.apiKeys, record] },
      token: `inkling_${id}.${secret}`,
    };
  });
}

export function authenticateApiKey(
  state: AuthenticationState,
  token: string,
  now: string,
): Effect.Effect<
  { readonly principal: Principal; readonly state: AuthenticationState },
  AuthenticationError | StorageError,
  typeof SecretHasher.Service
> {
  return Effect.gen(function* () {
    const match = /^inkling_([^.]+)\.(.+)$/u.exec(token);
    if (match === null) {
      return yield* authenticationFailure("invalid_token", "The API key is invalid.");
    }
    const id = match[1];
    const secret = match[2];
    const index = state.apiKeys.findIndex((record) => record.id === id);
    const record = state.apiKeys[index];
    if (
      id === undefined ||
      secret === undefined ||
      record === undefined ||
      record.revokedAt !== undefined
    ) {
      return yield* authenticationFailure("invalid_token", "The API key is invalid or revoked.");
    }
    const hasher = yield* SecretHasher;
    if (!(yield* hasher.verify(secret, record.tokenHash))) {
      return yield* authenticationFailure("invalid_token", "The API key is invalid.");
    }
    if (record.personId === undefined || !isWorkspaceRole(record.role)) {
      return yield* authenticationFailure("invalid_token", "The API key is invalid or revoked.");
    }
    const updated = { ...record, lastUsedAt: now };
    return {
      principal: {
        displayName: record.displayName,
        keyId: id,
        kind: "api-key",
        personId: record.personId,
        role: record.role,
      },
      state: {
        ...state,
        apiKeys: state.apiKeys.map((item, itemIndex) => (itemIndex === index ? updated : item)),
      },
    };
  });
}

export function apiKeyBelongsTo(record: ApiKeyRecord, accountId: PersonId): boolean {
  return record.personId === accountId;
}

export function revokeApiKey(
  state: AuthenticationState,
  id: string,
  accountId: PersonId,
  now: string,
): Effect.Effect<AuthenticationState, AuthenticationError> {
  const index = state.apiKeys.findIndex(
    (record) => record.id === id && apiKeyBelongsTo(record, accountId),
  );
  if (index === -1) {
    return authenticationFailure("invalid_token", "The API key does not exist.");
  }
  return Effect.succeed({
    ...state,
    apiKeys: state.apiKeys.map((record, recordIndex) =>
      recordIndex === index ? { ...record, revokedAt: now } : record,
    ),
  });
}

function isWorkspaceRole(role: WorkspaceRole | undefined): role is WorkspaceRole {
  return role === "member" || role === "administrator";
}

function authenticationFailure<A = never>(
  code: AuthenticationError["code"],
  message: string,
): Effect.Effect<A, AuthenticationError> {
  return Effect.fail(new AuthenticationError({ code, message }));
}
