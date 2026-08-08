import { Effect, Predicate } from "effect";

import { personId } from "@earendil-works/jot-core";
import type { PeopleDirectoryEntry, WorkspaceIdentity } from "@earendil-works/jot-core";

import type { SessionResult } from "./application.ts";

const domainPattern =
  /^(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)+[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/u;

export interface GoogleAuthenticationEnvironment {
  readonly GOOGLE_ADMIN_EMAILS?: string | undefined;
  readonly GOOGLE_ALLOWED_DOMAIN?: string | undefined;
  readonly GOOGLE_ALLOWED_DOMAINS?: string | undefined;
  readonly GOOGLE_CLIENT_ID?: string | undefined;
  readonly GOOGLE_CLIENT_SECRET?: string | undefined;
  readonly GOOGLE_REDIRECT_URI?: string | undefined;
  readonly JOT_GOOGLE_AUTHORIZATION_ENDPOINT?: string | undefined;
  readonly JOT_GOOGLE_CERTIFICATES_ENDPOINT?: string | undefined;
  readonly JOT_GOOGLE_DIRECTORY_ENDPOINT?: string | undefined;
  readonly JOT_GOOGLE_TOKEN_ENDPOINT?: string | undefined;
  readonly JOT_OAUTH_STATE_SECRET?: string | undefined;
}

export type GoogleIdentityLogin = (
  identity: WorkspaceIdentity,
  people: readonly PeopleDirectoryEntry[],
) => Promise<SessionResult>;

interface OAuthStatePayload {
  readonly expiresAt: number;
  readonly nonce: string;
  readonly redirectUri: string;
  readonly state: string;
  readonly verifier: string;
}

interface GoogleDirectoryPerson {
  readonly aliases: readonly string[];
  readonly displayName: string;
  readonly email: string;
}

interface GoogleIdentityClaims {
  readonly aud: string;
  readonly email: string;
  readonly email_verified: boolean;
  readonly exp: number;
  readonly hd?: string | undefined;
  readonly iss: string;
  readonly name?: string | undefined;
  readonly nonce: string;
  readonly sub: string;
}

export function parseAllowedGoogleDomains(value: string | undefined): readonly string[] {
  if (value === undefined) return [];
  return [
    ...new Set(
      value
        .split(",")
        .map((domain) => domain.trim().replace(/^@/u, "").toLocaleLowerCase("en"))
        .filter((domain) => domainPattern.test(domain)),
    ),
  ];
}

export function isGoogleEmailAllowed(email: string, allowedDomains: readonly string[]): boolean {
  const separator = email.lastIndexOf("@");
  if (separator <= 0 || separator === email.length - 1) return false;
  const domain = email.slice(separator + 1).toLocaleLowerCase("en");
  return allowedDomains.includes(domain);
}

export async function startGoogleAuthentication(
  request: Request,
  environment: GoogleAuthenticationEnvironment,
): Promise<Response> {
  const configuration = googleConfiguration(request, environment);
  if (configuration === undefined) return oauthUnavailable();
  const verifier = randomBase64Url(32);
  const challenge = base64Url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
  );
  const payload: OAuthStatePayload = {
    expiresAt: Date.now() + 10 * 60 * 1_000,
    nonce: randomBase64Url(24),
    redirectUri: configuration.redirectUri,
    state: randomBase64Url(24),
    verifier,
  };
  const cookie = await signOAuthState(payload, configuration.stateSecret);
  const authorization = new URL(configuration.authorizationEndpoint);
  authorization.searchParams.set("client_id", configuration.clientId);
  authorization.searchParams.set("redirect_uri", configuration.redirectUri);
  authorization.searchParams.set("response_type", "code");
  authorization.searchParams.set(
    "scope",
    "openid email profile https://www.googleapis.com/auth/admin.directory.user.readonly",
  );
  authorization.searchParams.set("state", payload.state);
  authorization.searchParams.set("nonce", payload.nonce);
  authorization.searchParams.set("code_challenge", challenge);
  authorization.searchParams.set("code_challenge_method", "S256");
  if (configuration.allowedDomains.length === 1) {
    authorization.searchParams.set("hd", configuration.allowedDomains[0] ?? "");
  }
  const headers = new Headers({ Location: authorization.href });
  headers.append(
    "Set-Cookie",
    cookieHeader("jot_oauth", cookie, request, {
      httpOnly: true,
      maxAge: 600,
      path: "/api/auth/google/callback",
      sameSite: "Lax",
    }),
  );
  return new Response(null, { headers, status: 302 });
}

export async function finishGoogleAuthentication(
  request: Request,
  environment: GoogleAuthenticationEnvironment,
  login: GoogleIdentityLogin,
): Promise<Response> {
  const configuration = googleConfiguration(request, environment);
  if (configuration === undefined) return oauthUnavailable();
  try {
    const url = new URL(request.url);
    const stateCookie = parseCookies(request.headers.get("Cookie"))["jot_oauth"];
    const payload =
      stateCookie === undefined
        ? undefined
        : await verifyOAuthState(stateCookie, configuration.stateSecret);
    const code = url.searchParams.get("code");
    if (
      payload === undefined ||
      payload.expiresAt <= Date.now() ||
      payload.state !== url.searchParams.get("state") ||
      payload.redirectUri !== configuration.redirectUri ||
      code === null
    ) {
      return oauthFailure("The OAuth state is invalid or expired.");
    }
    const tokenResponse = await fetch(configuration.tokenEndpoint, {
      body: new URLSearchParams({
        client_id: configuration.clientId,
        client_secret: configuration.clientSecret,
        code,
        code_verifier: payload.verifier,
        grant_type: "authorization_code",
        redirect_uri: configuration.redirectUri,
      }),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    const tokenBody = (await tokenResponse.json()) as unknown;
    const idToken =
      Predicate.isReadonlyRecord(tokenBody) && typeof tokenBody["id_token"] === "string"
        ? tokenBody["id_token"]
        : undefined;
    const accessToken =
      Predicate.isReadonlyRecord(tokenBody) && typeof tokenBody["access_token"] === "string"
        ? tokenBody["access_token"]
        : undefined;
    if (!tokenResponse.ok || idToken === undefined) {
      return oauthFailure("Google rejected the authorization code.");
    }
    const claims = await verifyGoogleIdentityToken(
      idToken,
      configuration.clientId,
      payload.nonce,
      configuration.certificatesEndpoint,
    );
    if (
      claims === undefined ||
      !claims.email_verified ||
      !isGoogleEmailAllowed(claims.email, configuration.allowedDomains)
    ) {
      return oauthFailure("The Google identity is not a verified member of an allowed domain.");
    }
    const email = claims.email.toLocaleLowerCase("en");
    const administrators = new Set(
      (environment.GOOGLE_ADMIN_EMAILS ?? "")
        .split(",")
        .map((value) => value.trim().toLocaleLowerCase("en"))
        .filter(Boolean),
    );
    const identity: WorkspaceIdentity = {
      displayName: claims.name?.trim() || email,
      email,
      personId: await Effect.runPromise(personId(email)),
      role: administrators.has(email) ? "administrator" : "member",
    };
    const directoryPeople =
      accessToken === undefined
        ? []
        : await readGoogleDirectory(accessToken, configuration.directoryEndpoint).catch(() => []);
    const people = await Promise.all(
      directoryPeople.map(async (person): Promise<PeopleDirectoryEntry> => ({
        aliases: person.aliases,
        person: {
          displayName: person.displayName,
          email: person.email,
          id: await Effect.runPromise(personId(person.email)),
        },
      })),
    );
    const session = await login(identity, people);
    const headers = new Headers({ Location: "/" });
    headers.append(
      "Set-Cookie",
      cookieHeader("jot_session", session.sessionToken, request, {
        expires: session.expiresAt,
        httpOnly: true,
        path: "/",
        sameSite: "Strict",
      }),
    );
    headers.append(
      "Set-Cookie",
      cookieHeader("jot_csrf", session.csrfToken, request, {
        expires: session.expiresAt,
        httpOnly: false,
        path: "/",
        sameSite: "Strict",
      }),
    );
    headers.append(
      "Set-Cookie",
      cookieHeader("jot_oauth", "", request, {
        httpOnly: true,
        maxAge: 0,
        path: "/api/auth/google/callback",
        sameSite: "Lax",
      }),
    );
    return new Response(null, { headers, status: 302 });
  } catch {
    return oauthFailure("Google authentication could not be completed.");
  }
}

function googleConfiguration(request: Request, environment: GoogleAuthenticationEnvironment) {
  const clientId = environment.GOOGLE_CLIENT_ID;
  const clientSecret = environment.GOOGLE_CLIENT_SECRET;
  const allowedDomains = parseAllowedGoogleDomains(
    environment.GOOGLE_ALLOWED_DOMAINS ?? environment.GOOGLE_ALLOWED_DOMAIN,
  );
  if (clientId === undefined || clientSecret === undefined || allowedDomains.length === 0) {
    return undefined;
  }
  return {
    allowedDomains,
    authorizationEndpoint:
      environment.JOT_GOOGLE_AUTHORIZATION_ENDPOINT ??
      "https://accounts.google.com/o/oauth2/v2/auth",
    certificatesEndpoint:
      environment.JOT_GOOGLE_CERTIFICATES_ENDPOINT ?? "https://www.googleapis.com/oauth2/v3/certs",
    clientId,
    clientSecret,
    directoryEndpoint:
      environment.JOT_GOOGLE_DIRECTORY_ENDPOINT ??
      "https://admin.googleapis.com/admin/directory/v1/users",
    redirectUri:
      environment.GOOGLE_REDIRECT_URI ?? `${new URL(request.url).origin}/api/auth/google/callback`,
    stateSecret: environment.JOT_OAUTH_STATE_SECRET ?? clientSecret,
    tokenEndpoint: environment.JOT_GOOGLE_TOKEN_ENDPOINT ?? "https://oauth2.googleapis.com/token",
  };
}

async function readGoogleDirectory(
  accessToken: string,
  endpoint: string,
): Promise<readonly GoogleDirectoryPerson[]> {
  const people = new Map<string, GoogleDirectoryPerson>();
  const readPage = async (pageToken?: string, page = 0): Promise<void> => {
    if (page >= 100) throw new Error("Google Directory pagination exceeded the safety limit.");
    const url = new URL(endpoint);
    url.searchParams.set("customer", "my_customer");
    url.searchParams.set(
      "fields",
      "nextPageToken,users(primaryEmail,name/fullName,aliases,suspended,archived)",
    );
    url.searchParams.set("maxResults", "500");
    url.searchParams.set("orderBy", "email");
    url.searchParams.set("projection", "basic");
    url.searchParams.set("showDeleted", "false");
    if (pageToken !== undefined) url.searchParams.set("pageToken", pageToken);
    const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!response.ok) throw new Error("Google Directory rejected the access token.");
    const body = (await response.json()) as unknown;
    if (!Predicate.isReadonlyRecord(body)) {
      throw new Error("Google Directory returned an invalid response.");
    }
    const users = Array.isArray(body["users"]) ? body["users"] : [];
    for (const user of users) {
      if (
        !Predicate.isReadonlyRecord(user) ||
        user["suspended"] === true ||
        user["archived"] === true
      ) {
        continue;
      }
      const name = user["name"];
      const displayName =
        Predicate.isReadonlyRecord(name) && typeof name["fullName"] === "string"
          ? name["fullName"].trim()
          : "";
      const email =
        typeof user["primaryEmail"] === "string"
          ? user["primaryEmail"].trim().toLocaleLowerCase("en")
          : "";
      if (
        displayName === "" ||
        displayName.length > 200 ||
        email.length > 256 ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)
      ) {
        continue;
      }
      const aliases = Array.isArray(user["aliases"])
        ? [
            ...new Set(
              user["aliases"]
                .filter((alias): alias is string => typeof alias === "string")
                .map((alias) => alias.trim().toLocaleLowerCase("en"))
                .filter((alias) => alias !== email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(alias)),
            ),
          ].toSorted()
        : [];
      people.set(email, { aliases, displayName, email });
    }
    const nextPageToken =
      typeof body["nextPageToken"] === "string" ? body["nextPageToken"] : undefined;
    if (nextPageToken !== undefined) await readPage(nextPageToken, page + 1);
  };
  await readPage();
  return [...people.values()];
}

async function verifyGoogleIdentityToken(
  token: string,
  audience: string,
  nonce: string,
  certificatesEndpoint: string,
): Promise<GoogleIdentityClaims | undefined> {
  const [headerValue, claimsValue, signatureValue, extra] = token.split(".");
  if (
    headerValue === undefined ||
    claimsValue === undefined ||
    signatureValue === undefined ||
    extra !== undefined
  ) {
    return undefined;
  }
  const header = parseBase64UrlJson(headerValue);
  const claims = parseBase64UrlJson(claimsValue);
  if (
    !Predicate.isReadonlyRecord(header) ||
    header["alg"] !== "RS256" ||
    typeof header["kid"] !== "string" ||
    !isGoogleClaims(claims)
  ) {
    return undefined;
  }
  const keysResponse = await fetch(certificatesEndpoint);
  const keysBody = (await keysResponse.json()) as unknown;
  const keys =
    Predicate.isReadonlyRecord(keysBody) && Array.isArray(keysBody["keys"]) ? keysBody["keys"] : [];
  const jwk = keys.find(
    (candidate) => Predicate.isReadonlyRecord(candidate) && candidate["kid"] === header["kid"],
  );
  if (!Predicate.isReadonlyRecord(jwk)) return undefined;
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { hash: "SHA-256", name: "RSASSA-PKCS1-v1_5" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    ownedBytes(base64UrlBytes(signatureValue)),
    ownedBytes(new TextEncoder().encode(`${headerValue}.${claimsValue}`)),
  );
  return valid &&
    (claims.iss === "https://accounts.google.com" || claims.iss === "accounts.google.com") &&
    claims.aud === audience &&
    claims.nonce === nonce &&
    claims.exp * 1_000 > Date.now()
    ? claims
    : undefined;
}

function isGoogleClaims(value: unknown): value is GoogleIdentityClaims {
  return (
    Predicate.isReadonlyRecord(value) &&
    typeof value["aud"] === "string" &&
    typeof value["email"] === "string" &&
    typeof value["email_verified"] === "boolean" &&
    typeof value["exp"] === "number" &&
    (value["hd"] === undefined || typeof value["hd"] === "string") &&
    typeof value["iss"] === "string" &&
    (value["name"] === undefined || typeof value["name"] === "string") &&
    typeof value["nonce"] === "string" &&
    typeof value["sub"] === "string"
  );
}

async function signOAuthState(payload: OAuthStatePayload, secret: string): Promise<string> {
  const encoded = base64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = await hmac("sign", secret, new TextEncoder().encode(encoded));
  return `${encoded}.${base64Url(new Uint8Array(signature))}`;
}

async function verifyOAuthState(
  value: string,
  secret: string,
): Promise<OAuthStatePayload | undefined> {
  const [payloadValue, signatureValue, extra] = value.split(".");
  if (payloadValue === undefined || signatureValue === undefined || extra !== undefined) {
    return undefined;
  }
  const valid = await hmac(
    "verify",
    secret,
    new TextEncoder().encode(payloadValue),
    base64UrlBytes(signatureValue),
  );
  if (!valid) return undefined;
  const parsed = parseBase64UrlJson(payloadValue);
  return Predicate.isReadonlyRecord(parsed) &&
    typeof parsed["expiresAt"] === "number" &&
    typeof parsed["nonce"] === "string" &&
    typeof parsed["redirectUri"] === "string" &&
    typeof parsed["state"] === "string" &&
    typeof parsed["verifier"] === "string"
    ? (parsed as unknown as OAuthStatePayload)
    : undefined;
}

async function hmac(operation: "sign", secret: string, data: Uint8Array): Promise<ArrayBuffer>;
async function hmac(
  operation: "verify",
  secret: string,
  data: Uint8Array,
  signature: Uint8Array,
): Promise<boolean>;
async function hmac(
  operation: "sign" | "verify",
  secret: string,
  data: Uint8Array,
  signature?: Uint8Array,
): Promise<ArrayBuffer | boolean> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign", "verify"],
  );
  return operation === "sign"
    ? crypto.subtle.sign("HMAC", key, ownedBytes(data))
    : crypto.subtle.verify(
        "HMAC",
        key,
        ownedBytes(signature ?? new Uint8Array()),
        ownedBytes(data),
      );
}

function cookieHeader(
  name: string,
  value: string,
  request: Request,
  options: {
    readonly expires?: string | undefined;
    readonly httpOnly: boolean;
    readonly maxAge?: number | undefined;
    readonly path: string;
    readonly sameSite: "Lax" | "Strict";
  },
): string {
  return [
    `${name}=${value}`,
    `Path=${options.path}`,
    `SameSite=${options.sameSite}`,
    ...(options.httpOnly ? ["HttpOnly"] : []),
    ...(new URL(request.url).protocol === "https:" ? ["Secure"] : []),
    ...(options.expires === undefined
      ? []
      : [`Expires=${new Date(options.expires).toUTCString()}`]),
    ...(options.maxAge === undefined ? [] : [`Max-Age=${options.maxAge}`]),
  ].join("; ");
}

function oauthUnavailable(): Response {
  return Response.json(
    {
      code: "oauth_unavailable",
      message: "Google authentication is not configured.",
      retryable: false,
    },
    { headers: { "Cache-Control": "no-store" }, status: 503 },
  );
}

function oauthFailure(message: string): Response {
  return Response.json(
    { code: "oauth_failed", message, retryable: false },
    { headers: { "Cache-Control": "no-store" }, status: 401 },
  );
}

function parseCookies(header: string | null): Readonly<Record<string, string>> {
  if (header === null) return {};
  return Object.fromEntries(
    header.split(";").flatMap((part) => {
      const separator = part.indexOf("=");
      if (separator === -1) return [];
      return [[part.slice(0, separator).trim(), part.slice(separator + 1).trim()]];
    }),
  );
}

function randomBase64Url(length: number): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(length)));
}

function ownedBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(bytes);
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function base64UrlBytes(value: string): Uint8Array {
  const standard = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = standard.padEnd(Math.ceil(standard.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function parseBase64UrlJson(value: string): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(base64UrlBytes(value))) as unknown;
  } catch {
    return undefined;
  }
}
