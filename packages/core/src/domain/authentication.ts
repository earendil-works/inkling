import { Data, Effect } from "effect";

import { IdGenerator, SecretHasher, SecureToken } from "../application/ports.ts";
import type { StorageError } from "../application/ports.ts";
import { personId } from "./document.ts";
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
  readonly lastUsedAt?: string | undefined;
  readonly revokedAt?: string | undefined;
}

export interface AuthenticationState {
  readonly ownerPasswordHash?: string | undefined;
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
  readonly code:
    | "already_initialized"
    | "invalid_credentials"
    | "invalid_token"
    | "not_initialized";
  readonly message: string;
}> {}

export function emptyAuthenticationState(): AuthenticationState {
  return { apiKeys: [], sessions: [] };
}

export function setupOwner(
  state: AuthenticationState,
  password: string,
): Effect.Effect<
  AuthenticationState,
  AuthenticationError | StorageError,
  typeof SecretHasher.Service
> {
  return Effect.gen(function* () {
    if (state.ownerPasswordHash !== undefined) {
      return yield* authenticationFailure(
        "already_initialized",
        "The local owner is already configured.",
      );
    }
    yield* validatePassword(password);
    const hasher = yield* SecretHasher;
    const ownerPasswordHash = yield* hasher.hash(password);
    return { ...state, ownerPasswordHash };
  });
}

export function loginOwner(
  state: AuthenticationState,
  password: string,
  now: string,
  sessionLifetimeMilliseconds = 30 * 24 * 60 * 60 * 1000,
): Effect.Effect<
  CreatedSession,
  AuthenticationError | StorageError,
  typeof IdGenerator.Service | typeof SecretHasher.Service | typeof SecureToken.Service
> {
  return Effect.gen(function* () {
    if (state.ownerPasswordHash === undefined) {
      return yield* authenticationFailure(
        "not_initialized",
        "The local owner has not been configured.",
      );
    }
    const hasher = yield* SecretHasher;
    const valid = yield* hasher.verify(password, state.ownerPasswordHash);
    if (!valid) {
      return yield* authenticationFailure("invalid_credentials", "The password is incorrect.");
    }
    const ids = yield* IdGenerator;
    const tokens = yield* SecureToken;
    const id = yield* ids.generate("session");
    const secret = yield* tokens.generate(32);
    const tokenHash = yield* hasher.hash(secret);
    const expiresAt = new Date(Date.parse(now) + sessionLifetimeMilliseconds).toISOString();
    const record: SessionRecord = { createdAt: now, expiresAt, id, tokenHash };
    return {
      expiresAt,
      state: { ...state, sessions: [...state.sessions, record] },
      token: `${id}.${secret}`,
    };
  });
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
    return record.personId === undefined || record.role === undefined
      ? ownerPrincipal(yield* localOwnerId())
      : {
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
      id,
      label: normalizedLabel,
      tokenHash: yield* hasher.hash(secret),
    };
    return {
      record,
      state: { ...state, apiKeys: [...state.apiKeys, record] },
      token: `jot_${id}.${secret}`,
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
    const match = /^jot_([^.]+)\.(.+)$/u.exec(token);
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
    const updated = { ...record, lastUsedAt: now };
    return {
      principal: {
        keyId: id,
        kind: "api-key",
        personId: yield* localOwnerId(),
        role: "owner",
      },
      state: {
        ...state,
        apiKeys: state.apiKeys.map((item, itemIndex) => (itemIndex === index ? updated : item)),
      },
    };
  });
}

export function revokeApiKey(
  state: AuthenticationState,
  id: string,
  now: string,
): Effect.Effect<AuthenticationState, AuthenticationError> {
  const index = state.apiKeys.findIndex((record) => record.id === id);
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

function localOwnerId(): Effect.Effect<PersonId, AuthenticationError> {
  return personId("owner@local").pipe(
    Effect.mapError(
      () =>
        new AuthenticationError({
          code: "invalid_token",
          message: "The built-in owner identity is invalid.",
        }),
    ),
  );
}

function ownerPrincipal(id: PersonId): Principal {
  return { kind: "workspace", personId: id, role: "owner" };
}

function validatePassword(password: string): Effect.Effect<void, AuthenticationError> {
  return password.length >= 12 && password.length <= 1024
    ? Effect.void
    : authenticationFailure(
        "invalid_credentials",
        "The owner password must contain at least 12 characters.",
      );
}

function authenticationFailure<A = never>(
  code: AuthenticationError["code"],
  message: string,
): Effect.Effect<A, AuthenticationError> {
  return Effect.fail(new AuthenticationError({ code, message }));
}
