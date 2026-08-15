import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Effect } from "effect";

import type {
  CatalogResponse,
  DocumentResponse,
  PersonDto,
  PresenceDto,
} from "@earendil-works/inkling-protocol";

import { ApiError, makeApiClient } from "./api.ts";
import type { ApiClientService } from "./api.ts";
import { AppContext } from "./app-context.tsx";
import type { AppContextValue, AppStatus, HeaderDocument, ToastKind } from "./app-context.tsx";
import { AppHeader } from "./components/app-header.tsx";
import type { BreadcrumbItem } from "./components/app-header.tsx";
import { preloadDocumentScreen, RouteView } from "./components/route-view.tsx";
import type { RouteModel } from "./components/route-view.tsx";
import { ToastRegion } from "./components/toast-region.tsx";
import type { ToastController } from "./components/toast-region.tsx";
import { useEffectQuery } from "./effect-hooks.ts";
import type { FrontmatterVocabulary } from "./frontmatter-completion.ts";
import { installClientRouter } from "./navigation.ts";
import type { ClientRouter, NavigateOptions } from "./navigation.ts";

interface LocationState {
  readonly generation: number;
  readonly url: URL;
}

export function App(): React.JSX.Element {
  const [locationState, setLocationState] = useState<LocationState>(() => ({
    generation: 0,
    url: new URL(location.href),
  }));
  const routerRef = useRef<ClientRouter | undefined>(undefined);
  const [status, setStatus] = useState<AppStatus>();
  const [headerDocument, setHeaderDocument] = useState<HeaderDocument>();
  const [participants, setParticipants] = useState<readonly PresenceDto[]>([]);
  const toastRef = useRef<ToastController>(null);

  useEffect(() => {
    const router = installClientRouter(isApplicationUrl, () =>
      setLocationState((current) => ({
        generation: current.generation + 1,
        url: new URL(location.href),
      })),
    );
    routerRef.current = router;
    return () => {
      router.dispose();
      routerRef.current = undefined;
    };
  }, []);

  const navigate = useCallback((destination: string | URL, options?: NavigateOptions) => {
    const router = routerRef.current;
    if (router === undefined) {
      location.assign(String(destination));
      return;
    }
    router.navigate(destination, options);
  }, []);
  const refreshRoute = useCallback(() => routerRef.current?.refresh(), []);
  const showToast = useCallback(
    (message: string, kind: ToastKind) => toastRef.current?.show(message, kind),
    [],
  );

  const routeEffect = useMemo(() => loadRoute(locationState.url), [locationState.url]);
  const route = useEffectQuery(
    routeEffect,
    `${locationState.url.href}:${locationState.generation}`,
  );
  const navigating = route.state.status === "loading";
  const breadcrumbs = breadcrumbsForRoute(route.state.data, locationState.url, headerDocument);
  const pageTitle =
    route.state.data?.screen === "editor" || route.state.data?.screen === "reader"
      ? route.state.data.screen === "editor" &&
        headerDocument?.id === route.state.data.document.metadata.id
        ? headerDocument.title
        : route.state.data.document.metadata.title
      : "Inkling";

  useEffect(() => {
    document.title = pageTitle;
  }, [pageTitle]);
  useEffect(() => {
    if (status === undefined) {
      delete document.documentElement.dataset["api"];
    } else {
      document.documentElement.dataset["api"] = status.state;
    }
  }, [status]);
  useEffect(() => {
    const root = document.documentElement;
    let completionTimer: ReturnType<typeof setTimeout> | undefined;
    if (navigating) {
      delete root.dataset["navigationComplete"];
      root.dataset["navigating"] = "";
    } else if (root.dataset["navigating"] !== undefined) {
      delete root.dataset["navigating"];
      root.dataset["navigationComplete"] = "";
      completionTimer = setTimeout(() => delete root.dataset["navigationComplete"], 180);
    }
    return () => {
      if (completionTimer !== undefined) clearTimeout(completionTimer);
    };
  }, [navigating]);
  useEffect(() => {
    if (route.state.status === "failure" && route.state.data !== undefined) {
      showToast(route.state.error.message, "error");
    }
  }, [route.state, showToast]);

  const context = useMemo<AppContextValue>(
    () => ({
      navigate,
      refreshRoute,
      setHeaderDocument,
      setParticipants,
      setStatus,
      showToast,
    }),
    [navigate, refreshRoute, showToast],
  );

  return (
    <AppContext.Provider value={context}>
      <AppHeader
        account={route.state.data?.account}
        api={route.state.data?.api}
        breadcrumbs={breadcrumbs}
        participants={participants}
        status={status}
      />
      <RouteView
        navigationKey={locationState.generation}
        refresh={route.refresh}
        state={route.state}
      />
      <ToastRegion ref={toastRef} />
    </AppContext.Provider>
  );
}

function breadcrumbsForRoute(
  model: RouteModel | undefined,
  url: URL,
  headerDocument: HeaderDocument | undefined,
): readonly BreadcrumbItem[] {
  const home: BreadcrumbItem = { href: "/", label: "Inkling" };
  if (model === undefined) return [home];

  if (model.screen === "labels") {
    const labels: BreadcrumbItem = {
      href: model.selectedLabel === undefined ? undefined : "/labels",
      label: "Labels",
    };
    return model.selectedLabel === undefined
      ? [home, labels]
      : [home, labels, { label: model.selectedLabel, truncate: true }];
  }

  if (model.screen === "trash") {
    return [home, { label: "Trash" }];
  }

  if (model.screen === "workspace") {
    const query = url.searchParams.get("q")?.trim().toLocaleLowerCase("en");
    if (query === "is:rfc") return [home, { label: "RFCs" }];
    if (query === "is:note") return [home, { label: "Notes" }];
    return [home];
  }

  if (model.screen === "share-password") {
    return [home, { label: "Shared document" }];
  }

  const initial = model.document.metadata;
  const document =
    model.screen === "editor" && headerDocument?.id === initial.id ? headerDocument : initial;
  const rfc = document.rfcNumber;
  const deleted = initial.deletedAt !== undefined;
  const section: BreadcrumbItem = deleted
    ? { href: "/trash", label: "Trash" }
    : {
        href: `/?q=${encodeURIComponent(rfc === undefined ? "is:note" : "is:rfc")}`,
        label: rfc === undefined ? "Notes" : "RFCs",
      };
  const documentLabel =
    rfc === undefined ? document.title : `${String(rfc).padStart(4, "0")} - ${document.title}`;
  const documentBreadcrumb: BreadcrumbItem = {
    href:
      model.screen === "editor"
        ? `${url.pathname.replace(/\/edit\/?$/u, "")}${url.search}`
        : undefined,
    label: documentLabel,
    truncate: true,
  };
  return model.screen === "editor"
    ? [home, section, documentBreadcrumb, { label: "Edit" }]
    : [home, section, documentBreadcrumb];
}

function loadRoute(url: URL): Effect.Effect<RouteModel, ApiError> {
  const capabilityToken = url.searchParams.get("cap") ?? undefined;
  const api = makeApiClient(capabilityToken);
  const shared = /^\/share\/([^/]+)(?:\/(edit))?\/?$/u.exec(url.pathname);
  const documentRoute = /^\/documents\/([^/]+)(?:\/(edit))?\/?$/u.exec(url.pathname);
  const rfcRoute = /^\/rfc\/(\d+)(?:\/(edit))?\/?$/u.exec(url.pathname);
  if (shared?.[1] !== undefined) {
    const documentId = decodeURIComponent(shared[1]);
    return loadDocumentRoute(
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
      ? loadRfcRoute(api, capabilityToken, number, rfcRoute[2] === "edit" ? "editor" : "reader")
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
  api: ApiClientService,
  capabilityToken: string | undefined,
  number: number,
  screen: "editor" | "reader",
): Effect.Effect<RouteModel, ApiError> {
  return api.authenticationStatus.pipe(
    Effect.flatMap((authentication): Effect.Effect<RouteModel, ApiError> => {
      if (!authentication.authenticated) {
        return api.listPublicDocuments(String(number)).pipe(
          Effect.flatMap((catalog) => {
            const document = catalog.documents.find(
              (candidate) => candidate.metadata.rfcNumber === number,
            );
            return document === undefined
              ? Effect.fail(
                  new ApiError({
                    code: "not_found",
                    message: `RFC ${String(number).padStart(4, "0")} does not exist.`,
                    retryable: false,
                    status: 404,
                  }),
                )
              : loadDocumentRoute(api, capabilityToken, document.metadata.id, screen, false);
          }),
        );
      }
      return api.listDocuments(`rfc:${number}`).pipe(
        Effect.flatMap((catalog) => {
          const document = catalog.documents.find(
            (candidate) => candidate.metadata.rfcNumber === number,
          );
          return document === undefined
            ? Effect.fail(
                new ApiError({
                  code: "not_found",
                  message: `RFC ${String(number).padStart(4, "0")} does not exist.`,
                  retryable: false,
                  status: 404,
                }),
              )
            : loadDocumentRoute(api, capabilityToken, document.metadata.id, screen, false);
        }),
      );
    }),
  );
}

function loadDocumentRoute(
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
    try: () => preloadDocumentScreen(screen),
  });
  return Effect.all(
    [api.readDocument(documentId, screen === "reader"), api.authenticationStatus, preload],
    {
      concurrency: "unbounded",
    },
  ).pipe(
    Effect.flatMap(([document, authentication]) =>
      (screen === "editor" && !shared && authentication.authenticated
        ? api.listDocuments().pipe(Effect.catchAll(() => Effect.succeed(undefined)))
        : Effect.succeed(undefined)
      ).pipe(
        Effect.map((catalog): RouteModel => ({
          account: authentication.authenticated ? authentication.principal : undefined,
          api,
          capabilityToken,
          document,
          frontmatterVocabulary: collectFrontmatterVocabulary(
            document,
            catalog,
            accountPerson(authentication.principal),
          ),
          publicDocument: !authentication.authenticated && !shared,
          screen,
          shared,
        })),
      ),
    ),
  );
}

function accountPerson(
  person:
    | {
        readonly displayName: string;
        readonly email?: string | undefined;
        readonly id: string;
      }
    | undefined,
): readonly PersonDto[] {
  return person?.email === undefined
    ? []
    : [{ displayName: person.displayName, email: person.email, id: person.id }];
}

function collectFrontmatterVocabulary(
  document: DocumentResponse,
  catalog: CatalogResponse | undefined,
  accountPeople: readonly PersonDto[],
): FrontmatterVocabulary {
  const metadata = [
    document.metadata,
    ...(catalog?.documents.map((summary) => summary.metadata) ?? []),
  ];
  const people = [
    ...accountPeople,
    ...(catalog?.people ?? []),
    ...metadata.flatMap((item) => [...item.authors, ...item.reviewers, ...item.approvers]),
  ];
  return {
    labels: [...new Set(metadata.flatMap((item) => item.labels))].toSorted((left, right) =>
      left.localeCompare(right),
    ),
    people: [
      ...new Map(
        people.map((person) => [person.email.toLocaleLowerCase("en"), person] as const),
      ).values(),
    ],
    states: [...new Set(metadata.map((item) => item.lifecycleState))].toSorted((left, right) =>
      left.localeCompare(right),
    ),
  };
}

function isApplicationUrl(url: URL): boolean {
  return (
    url.origin === location.origin &&
    (url.pathname === "/" ||
      url.pathname === "/labels" ||
      url.pathname === "/trash" ||
      url.pathname.startsWith("/documents/") ||
      url.pathname.startsWith("/rfc/") ||
      url.pathname.startsWith("/share/"))
  );
}
