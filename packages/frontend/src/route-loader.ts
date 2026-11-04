import { Effect, Option } from "effect";

import { collectReferences } from "@earendil-works/inkling-renderer";
import type { DocumentResponse, ReferenceResolutionDto } from "@earendil-works/inkling-protocol";

import { ApiError } from "./api.ts";
import type { ApiClientService } from "./api.ts";
import { accountPerson, collectFrontmatterVocabulary } from "./frontmatter-completion.ts";
import type { RouteModel } from "./route-data.ts";
import { formatRfcNumber } from "./ui.ts";

/** How routes reach the API and their code; the server renderer supplies its own. */
export interface RouteEnvironment {
  readonly api: (capabilityToken: string | undefined) => ApiClientService;
  readonly preloadDocumentScreen: (screen: "editor" | "reader") => Promise<unknown>;
}

/** Whether a same-origin path is rendered by the application rather than the server. */
export function isApplicationPath(pathname: string): boolean {
  return (
    pathname === "/" ||
    pathname === "/labels" ||
    pathname === "/trash" ||
    pathname.startsWith("/documents/") ||
    pathname.startsWith("/rfc/") ||
    pathname.startsWith("/share/")
  );
}

export function loadRoute(
  url: URL,
  environment: RouteEnvironment,
): Effect.Effect<RouteModel, ApiError> {
  const capabilityToken = url.searchParams.get("cap") ?? undefined;
  const load = Effect.suspend(() => {
    const client = environment.api(capabilityToken);
    // Several steps of a route need the authentication status; ask once.
    return Effect.cached(client.authenticationStatus).pipe(
      Effect.flatMap((authenticationStatus) =>
        loadRouteWith(url, environment, capabilityToken, { ...client, authenticationStatus }),
      ),
    );
  });
  // The browser remembers the status between routes; a refusal means the
  // session ended since, so the route loads once more with a fresh status.
  return load.pipe(
    Effect.catchIf(
      (error) => error.status === 401,
      () => load,
    ),
  );
}

function loadRouteWith(
  url: URL,
  environment: RouteEnvironment,
  capabilityToken: string | undefined,
  api: ApiClientService,
): Effect.Effect<RouteModel, ApiError> {
  const shared = /^\/share\/([^/]+)(?:\/(edit))?\/?$/u.exec(url.pathname);
  const documentRoute = /^\/documents\/([^/]+)(?:\/(edit))?\/?$/u.exec(url.pathname);
  const rfcRoute = /^\/rfc\/(\d+)(?:\/(edit))?\/?$/u.exec(url.pathname);
  if (shared?.[1] !== undefined) {
    const documentId = decodeURIComponent(shared[1]);
    return loadDocumentRoute(
      environment,
      api,
      capabilityToken,
      documentId,
      shared[2] === "edit" ? "editor" : "reader",
      true,
    ).pipe(
      Effect.catchIf(
        (error) => error.code === "capability_password_required",
        (): Effect.Effect<RouteModel> =>
          Effect.succeed({
            api,
            capabilityToken,
            documentId,
            screen: "share-password",
          }),
      ),
    );
  }
  if (documentRoute?.[1] !== undefined) {
    return loadDocumentRoute(
      environment,
      api,
      capabilityToken,
      decodeURIComponent(documentRoute[1]),
      documentRoute[2] === "edit" ? "editor" : "reader",
      false,
    );
  }
  if (rfcRoute?.[1] !== undefined) {
    const number = Number(rfcRoute[1]);
    return Number.isSafeInteger(number) && number > 0
      ? loadRfcRoute(
          environment,
          api,
          capabilityToken,
          number,
          rfcRoute[2] === "edit" ? "editor" : "reader",
        )
      : Effect.fail(
          new ApiError({
            code: "invalid_rfc_number",
            message: "The RFC number is invalid.",
            retryable: false,
            status: 400,
          }),
        );
  }
  return api.authenticationStatus.pipe(
    Effect.flatMap((authentication) => {
      const publicCatalog = !authentication.authenticated;
      const loadCatalog = publicCatalog ? api.listPublicDocuments : api.listDocuments;
      if (url.pathname === "/trash") {
        return api.listDeletedDocuments.pipe(
          Effect.map((catalog): RouteModel => ({
            account: authentication.principal,
            api,
            capabilityToken,
            catalog,
            screen: "trash",
          })),
        );
      }
      if (url.pathname === "/labels") {
        return loadCatalog().pipe(
          Effect.map((catalog): RouteModel => ({
            account: authentication.principal,
            api,
            capabilityToken,
            catalog,
            publicCatalog,
            screen: "labels",
            selectedLabel: url.searchParams.get("label") ?? undefined,
          })),
        );
      }
      return loadCatalog(url.searchParams.get("q") ?? "").pipe(
        Effect.map((catalog): RouteModel => ({
          account: authentication.principal,
          api,
          capabilityToken,
          catalog,
          publicCatalog,
          screen: "workspace",
        })),
      );
    }),
  );
}

function loadRfcRoute(
  environment: RouteEnvironment,
  api: ApiClientService,
  capabilityToken: string | undefined,
  number: number,
  screen: "editor" | "reader",
): Effect.Effect<RouteModel, ApiError> {
  // Most readers of an RFC page are signed in, so look the number up in
  // the workspace catalog while the status loads; anonymous readers, who
  // cannot read it, look it up among public RFCs once the status says so.
  return Effect.all(
    [api.authenticationStatus, api.listDocuments(`rfc:${number}`).pipe(Effect.option)],
    { concurrency: "unbounded" },
  ).pipe(
    Effect.flatMap(([authentication, workspaceCatalog]) =>
      authentication.authenticated && Option.isSome(workspaceCatalog)
        ? Effect.succeed(workspaceCatalog.value)
        : authentication.authenticated
          ? api.listDocuments(`rfc:${number}`)
          : api.listPublicDocuments(String(number)),
    ),
    Effect.flatMap((catalog) => {
      const document = catalog.documents.find(
        (candidate) => candidate.metadata.rfcNumber === number,
      );
      if (document !== undefined) {
        return loadDocumentRoute(
          environment,
          api,
          capabilityToken,
          document.metadata.id,
          screen,
          false,
        );
      }
      // Anonymous readers only see public RFCs; a missing one may be private.
      return api.authenticationStatus.pipe(
        Effect.flatMap((authentication) =>
          Effect.fail(
            authentication.authenticated
              ? new ApiError({
                  code: "not_found",
                  message: `RFC ${formatRfcNumber(number)} does not exist.`,
                  retryable: false,
                  status: 404,
                })
              : signInRequired(404),
          ),
        ),
      );
    }),
  );
}

/**
 * Explains a refused document without authorization internals, and asks
 * anonymous readers to sign in.
 */
function accessDenied(api: ApiClientService, cause: ApiError): Effect.Effect<never, ApiError> {
  return api.authenticationStatus.pipe(
    Effect.map((authentication) => authentication.authenticated),
    Effect.orElseSucceed(() => false),
    Effect.flatMap((authenticated) =>
      Effect.fail(
        authenticated
          ? new ApiError({
              cause,
              code: "forbidden",
              message: "Your account cannot open this document.",
              retryable: false,
              status: cause.status,
            })
          : signInRequired(cause.status, cause),
      ),
    ),
  );
}

function signInRequired(status: number, cause?: ApiError): ApiError {
  return new ApiError({
    cause,
    code: "sign_in_required",
    message: "Sign in to open this document.",
    retryable: false,
    status,
  });
}

function loadDocumentRoute(
  environment: RouteEnvironment,
  api: ApiClientService,
  capabilityToken: string | undefined,
  documentId: string,
  screen: "editor" | "reader",
  shared: boolean,
): Effect.Effect<RouteModel, ApiError> {
  const preload = Effect.tryPromise({
    catch: (cause) =>
      new ApiError({
        cause,
        code: "chunk_load_failed",
        message: "Inkling could not load this view.",
        retryable: true,
        status: 0,
      }),
    try: () => environment.preloadDocumentScreen(screen),
  });
  return Effect.all(
    [
      api.readDocument(documentId, screen === "reader").pipe(
        Effect.catchIf(
          (error) => error.code === "forbidden",
          (error) => accessDenied(api, error),
        ),
      ),
      api.authenticationStatus,
      preload,
    ],
    {
      concurrency: "unbounded",
    },
  ).pipe(
    Effect.flatMap(([document, authentication]) =>
      resolveDocumentReferences(api, document).pipe(
        Effect.map((references) => [document, authentication, references] as const),
      ),
    ),
    // The editor completes frontmatter from the whole catalog, but loads it
    // after it opens; the route only waits for what it shows first.
    Effect.map(([document, authentication, references]): RouteModel => ({
      account: authentication.authenticated ? authentication.principal : undefined,
      api,
      capabilityToken,
      document,
      frontmatterVocabulary: collectFrontmatterVocabulary(
        document,
        undefined,
        accountPerson(authentication.principal),
      ),
      publicDocument: !authentication.authenticated && !shared,
      references,
      screen,
      shared,
    })),
  );
}

/**
 * Resolves the references a document makes, so it first renders with their
 * targets. When that fails, the document renders them pending and resolves
 * them again once it shows.
 */
function resolveDocumentReferences(
  api: ApiClientService,
  document: DocumentResponse,
): Effect.Effect<Readonly<Record<string, ReferenceResolutionDto>>> {
  return collectReferences(document.body).pipe(
    Effect.map((references) => [...new Set(references.map((reference) => reference.key))]),
    Effect.flatMap((keys) =>
      keys.length === 0
        ? Effect.succeed({})
        : api.resolveReferences(keys).pipe(Effect.map((response) => response.references)),
    ),
    Effect.orElseSucceed(() => ({})),
  );
}
