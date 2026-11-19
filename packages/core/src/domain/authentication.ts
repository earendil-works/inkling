import { Data, Effect } from "effect";

import { identifierTag } from "../application/identifiers.ts";
import { IdGenerator, SecureToken, TokenHasher } from "../application/ports.ts";
import type { StorageError } from "../application/ports.ts";
import type { PersonId } from "./document.ts";
import type { ApiKeyAccess, Principal, WorkspaceRole } from "./authorization.ts";

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
  /** Retained so the signed-in owner can reveal and reuse the key. */
  readonly retainedSecret?: string | undefined;
  readonly createdAt: string;
  /** Optional only while decoding legacy keys, which are invalid until recreated by a user. */
  readonly personId?: PersonId | undefined;
  readonly role?: WorkspaceRole | undefined;
  readonly displayName?: string | undefined;
  readonly lastUsedAt?: string | undefined;
  /** Set when the key was issued to an OAuth client instead of created by its owner. */
  readonly oauthClientName?: string | undefined;
  /** Keys created before access levels have none and keep full access. */
  readonly access?: ApiKeyAccess | undefined;
  readonly revokedAt?: string | undefined;
}

/**
 * A pending OAuth authorization code. Codes are single-use, expire quickly,
 * and are bound to the approving person, the client, its redirect URI, and a
 * PKCE challenge. Only a hash of the secret is stored.
 */
export interface AuthorizationCodeRecord {
  readonly id: string;
  readonly tokenHash: string;
  readonly clientId: string;
  readonly clientName: string;
  readonly redirectUri: string;
  /** Base64url SHA-256 of the client's PKCE code verifier. */
  readonly codeChallenge: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly personId: PersonId;
  readonly role: WorkspaceRole;
  readonly displayName?: string | undefined;
}

export interface AuthorizationGrant {
  readonly clientId: string;
  readonly clientName: string;
  readonly redirectUri: string;
  readonly codeChallenge: string;
}

export interface CreatedAuthorizationCode {
  readonly state: AuthenticationState;
  readonly token: string;
  readonly expiresAt: string;
}

export interface ApiKeyIdentity {
  readonly personId: PersonId;
  readonly role: WorkspaceRole;
  readonly displayName?: string | undefined;
}

export interface AuthenticationState {
  readonly sessions: readonly SessionRecord[];
  readonly apiKeys: readonly ApiKeyRecord[];
  readonly authorizationCodes: readonly AuthorizationCodeRecord[];
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
  readonly code: "invalid_grant" | "invalid_token";
  readonly message: string;
}> {}

export function emptyAuthenticationState(): AuthenticationState {
  return { apiKeys: [], authorizationCodes: [], sessions: [] };
}

export interface AuthenticatedSession {
  readonly principal: Principal;
  /** A replacement for the stored record, set when its hash scheme is outdated. */
  readonly updatedRecord?: SessionRecord | undefined;
}

export function authenticateSession(
  state: AuthenticationState,
  token: string,
  now: string,
): Effect.Effect<
  AuthenticatedSession,
  AuthenticationError | StorageError,
  typeof TokenHasher.Service
> {
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
    const hasher = yield* TokenHasher;
    if (!(yield* hasher.verify(secret, record.tokenHash))) {
      return yield* authenticationFailure("invalid_token", "The session token is invalid.");
    }
    if (record.personId === undefined || !isWorkspaceRole(record.role)) {
      return yield* authenticationFailure("invalid_token", "The session token is invalid.");
    }
    return {
      principal: {
        displayName: record.displayName,
        kind: "workspace",
        personId: record.personId,
        role: record.role,
      },
      updatedRecord: hasher.isOutdated(record.tokenHash)
        ? { ...record, tokenHash: yield* hasher.hash(secret) }
        : undefined,
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
  typeof IdGenerator.Service | typeof TokenHasher.Service | typeof SecureToken.Service
> {
  return Effect.gen(function* () {
    const hasher = yield* TokenHasher;
    const ids = yield* IdGenerator;
    const tokens = yield* SecureToken;
    const id = yield* ids.generate(identifierTag.session);
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
  options: {
    /** OAuth clients keep their own copy; their keys are never revealable. */
    readonly oauthClientName?: string | undefined;
    /** `read` creates a key that only reads; the default is full access. */
    readonly access?: ApiKeyAccess | undefined;
  } = {},
): Effect.Effect<
  CreatedApiKey,
  AuthenticationError | StorageError,
  typeof IdGenerator.Service | typeof TokenHasher.Service | typeof SecureToken.Service
> {
  return Effect.gen(function* () {
    const normalizedLabel = label.trim();
    if (normalizedLabel.length === 0 || normalizedLabel.length > 200) {
      return yield* authenticationFailure("invalid_token", "API key labels must be non-empty.");
    }
    const hasher = yield* TokenHasher;
    const ids = yield* IdGenerator;
    const tokens = yield* SecureToken;
    const id = yield* ids.generate(identifierTag.apiKey);
    const secret = yield* tokens.generate(32);
    const record: ApiKeyRecord = {
      access: options.access ?? "full",
      createdAt: now,
      displayName: identity.displayName,
      id,
      label: normalizedLabel,
      ...(options.oauthClientName === undefined
        ? { retainedSecret: secret }
        : { oauthClientName: options.oauthClientName }),
      personId: identity.personId,
      role: identity.role,
      tokenHash: yield* hasher.hash(secret),
    };
    return {
      record,
      state: { ...state, apiKeys: [...state.apiKeys, record] },
      token: `${id}.${secret}`,
    };
  });
}

/** How stale `lastUsedAt` may become before a request records its use again. */
const apiKeyUsageResolutionMilliseconds = 60 * 60 * 1000;

export interface AuthenticatedApiKey {
  readonly principal: Principal;
  /**
   * A replacement for the stored record, set only when its last use is stale
   * or its hash scheme is outdated, so most requests write nothing.
   */
  readonly updatedRecord?: ApiKeyRecord | undefined;
}

export function authenticateApiKey(
  state: AuthenticationState,
  token: string,
  now: string,
): Effect.Effect<
  AuthenticatedApiKey,
  AuthenticationError | StorageError,
  typeof TokenHasher.Service
> {
  return Effect.gen(function* () {
    // Keys issued before compact prefixes used an additional `inkling_` marker.
    const match = /^(?:inkling_)?(key_[^.]+)\.(.+)$/u.exec(token);
    if (match === null) {
      return yield* authenticationFailure("invalid_token", "The API key is invalid.");
    }
    const id = match[1];
    const secret = match[2];
    const record = state.apiKeys.find((candidate) => candidate.id === id);
    if (
      id === undefined ||
      secret === undefined ||
      record === undefined ||
      record.revokedAt !== undefined
    ) {
      return yield* authenticationFailure("invalid_token", "The API key is invalid or revoked.");
    }
    const hasher = yield* TokenHasher;
    if (!(yield* hasher.verify(secret, record.tokenHash))) {
      return yield* authenticationFailure("invalid_token", "The API key is invalid.");
    }
    if (
      record.personId === undefined ||
      !isWorkspaceRole(record.role) ||
      !isApiKeyAccess(record.access)
    ) {
      return yield* authenticationFailure("invalid_token", "The API key is invalid or revoked.");
    }
    const outdatedHash = hasher.isOutdated(record.tokenHash);
    const staleUse =
      record.lastUsedAt === undefined ||
      Date.parse(now) - Date.parse(record.lastUsedAt) >= apiKeyUsageResolutionMilliseconds;
    return {
      principal: {
        displayName: record.displayName,
        keyId: id,
        kind: "api-key",
        personId: record.personId,
        role: record.role,
        ...(record.access === "read" ? { access: "read" } : {}),
      },
      updatedRecord:
        outdatedHash || staleUse
          ? {
              ...record,
              lastUsedAt: now,
              tokenHash: outdatedHash ? yield* hasher.hash(secret) : record.tokenHash,
            }
          : undefined,
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

const authorizationCodeLifetimeMilliseconds = 5 * 60 * 1000;
const maximumPendingAuthorizationCodes = 20;

export function createAuthorizationCode(
  state: AuthenticationState,
  identity: ApiKeyIdentity,
  grant: AuthorizationGrant,
  now: string,
): Effect.Effect<
  CreatedAuthorizationCode,
  AuthenticationError | StorageError,
  typeof IdGenerator.Service | typeof TokenHasher.Service | typeof SecureToken.Service
> {
  return Effect.gen(function* () {
    const hasher = yield* TokenHasher;
    const ids = yield* IdGenerator;
    const tokens = yield* SecureToken;
    const id = yield* ids.generate(identifierTag.authorizationCode);
    const secret = yield* tokens.generate(32);
    const expiresAt = new Date(
      Date.parse(now) + authorizationCodeLifetimeMilliseconds,
    ).toISOString();
    const record: AuthorizationCodeRecord = {
      clientId: grant.clientId,
      clientName: grant.clientName,
      codeChallenge: grant.codeChallenge,
      createdAt: now,
      displayName: identity.displayName,
      expiresAt,
      id,
      personId: identity.personId,
      redirectUri: grant.redirectUri,
      role: identity.role,
      tokenHash: yield* hasher.hash(secret),
    };
    const pending = liveAuthorizationCodes(state, now);
    const ownPending = pending.filter((code) => code.personId === identity.personId);
    const evicted = new Set(
      ownPending
        .slice(0, Math.max(0, ownPending.length - maximumPendingAuthorizationCodes + 1))
        .map((code) => code.id),
    );
    return {
      expiresAt,
      state: {
        ...state,
        authorizationCodes: [...pending.filter((code) => !evicted.has(code.id)), record],
      },
      token: `${id}.${secret}`,
    };
  });
}

/**
 * Removes the code named by `token` (and every expired code) from the state.
 * Callers persist the returned state before verifying, so a code is consumed
 * by its first redemption attempt whether or not that attempt succeeds.
 */
export function takeAuthorizationCode(
  state: AuthenticationState,
  token: string,
  now: string,
): {
  readonly record?: AuthorizationCodeRecord | undefined;
  readonly secret?: string | undefined;
  readonly state: AuthenticationState;
} {
  const [id, secret, extra] = token.split(".");
  const pending = liveAuthorizationCodes(state, now);
  const record =
    id === undefined || secret === undefined || extra !== undefined
      ? undefined
      : pending.find((code) => code.id === id);
  return {
    record,
    secret: record === undefined ? undefined : secret,
    state: {
      ...state,
      authorizationCodes: pending.filter((code) => code.id !== record?.id),
    },
  };
}

export function verifyAuthorizationCode(
  record: AuthorizationCodeRecord,
  secret: string,
  grant: Omit<AuthorizationGrant, "clientName">,
  now: string,
): Effect.Effect<ApiKeyIdentity, AuthenticationError | StorageError, typeof TokenHasher.Service> {
  return Effect.gen(function* () {
    const hasher = yield* TokenHasher;
    const valid =
      Date.parse(record.expiresAt) > Date.parse(now) &&
      record.clientId === grant.clientId &&
      record.redirectUri === grant.redirectUri &&
      record.codeChallenge === grant.codeChallenge &&
      isWorkspaceRole(record.role) &&
      (yield* hasher.verify(secret, record.tokenHash));
    if (!valid) {
      return yield* authenticationFailure(
        "invalid_grant",
        "The authorization code is invalid, expired, or was issued to another client.",
      );
    }
    return { displayName: record.displayName, personId: record.personId, role: record.role };
  });
}

function liveAuthorizationCodes(
  state: AuthenticationState,
  now: string,
): readonly AuthorizationCodeRecord[] {
  return state.authorizationCodes.filter((code) => Date.parse(code.expiresAt) > Date.parse(now));
}

function isWorkspaceRole(role: WorkspaceRole | undefined): role is WorkspaceRole {
  return role === "member" || role === "administrator";
}

/** Absent on older keys, which keep full access; anything else is not a key. */
function isApiKeyAccess(access: unknown): access is ApiKeyAccess | undefined {
  return access === undefined || access === "full" || access === "read";
}

function authenticationFailure<A = never>(
  code: AuthenticationError["code"],
  message: string,
): Effect.Effect<A, AuthenticationError> {
  return Effect.fail(new AuthenticationError({ code, message }));
}
