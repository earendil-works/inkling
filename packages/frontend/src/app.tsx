import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Effect } from "effect";

import type {
  AuthenticationStatus,
  CatalogResponse,
  DocumentResponse,
  PresenceDto,
} from "@earendil-works/jot-protocol";

import { ApiError, makeApiClient } from "./api.ts";
import type { ApiClientService } from "./api.ts";
import { AppContext } from "./app-context.tsx";
import type { AppContextValue, AppStatus, ToastKind } from "./app-context.tsx";
import { AuthenticationScreen } from "./auth-screen.tsx";
import { AppHeader } from "./components/app-header.tsx";
import { Button } from "./components/button.tsx";
import { useEffectQuery } from "./effect-hooks.ts";
import { installClientRouter } from "./navigation.ts";
import type { ClientRouter, NavigateOptions } from "./navigation.ts";
import { WorkspaceScreen } from "./workspace-screen.tsx";

const loadEditorScreen = () =>
  import("./editor-screen.tsx").then(({ EditorScreen }) => ({ default: EditorScreen }));
const loadReaderScreen = () =>
  import("./reader-screen.tsx").then(({ ReaderScreen }) => ({ default: ReaderScreen }));
const EditorScreen = lazy(loadEditorScreen);
const ReaderScreen = lazy(loadReaderScreen);

interface LocationState {
  readonly generation: number;
  readonly url: URL;
}

interface RouteBase {
  readonly api: ApiClientService;
  readonly capabilityToken: string | undefined;
}

type RouteModel =
  | (RouteBase & {
      readonly methods: AuthenticationStatus["authenticationMethods"];
      readonly mode: "login" | "setup";
      readonly screen: "authentication";
    })
  | (RouteBase & {
      readonly document: DocumentResponse;
      readonly screen: "editor" | "reader";
      readonly shared: boolean;
    })
  | (RouteBase & { readonly catalog: CatalogResponse; readonly screen: "workspace" });

interface ToastMessage {
  readonly id: number;
  readonly kind: ToastKind;
  readonly message: string;
}

export function App(): React.JSX.Element {
  const [locationState, setLocationState] = useState<LocationState>(() => ({
    generation: 0,
    url: new URL(location.href),
  }));
  const routerRef = useRef<ClientRouter | undefined>(undefined);
  const [status, setStatus] = useState<AppStatus>({
    label: "Starting Effect runtime…",
    state: "connecting",
  });
  const [participants, setParticipants] = useState<readonly PresenceDto[]>([]);
  const [toasts, setToasts] = useState<readonly ToastMessage[]>([]);
  const toastIdRef = useRef(0);

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
  const showToast = useCallback((message: string, kind: ToastKind) => {
    const id = ++toastIdRef.current;
    setToasts((current) => [...current, { id, kind, message }]);
    window.setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }, 4_000);
  }, []);

  const routeEffect = useMemo(() => loadRoute(locationState.url), [locationState.url]);
  const route = useEffectQuery(
    routeEffect,
    `${locationState.url.href}:${locationState.generation}`,
  );
  const navigating = route.state.status === "loading";

  useEffect(() => {
    document.documentElement.dataset["api"] = status.state;
  }, [status.state]);
  useEffect(() => {
    if (navigating) {
      document.documentElement.dataset["navigating"] = "";
    } else {
      delete document.documentElement.dataset["navigating"];
    }
  }, [navigating]);
  useEffect(() => {
    if (route.state.status === "failure" && route.state.data !== undefined) {
      showToast(route.state.error.message, "error");
    }
  }, [route.state, showToast]);

  const context = useMemo<AppContextValue>(
    () => ({ navigate, refreshRoute, setParticipants, setStatus, showToast }),
    [navigate, refreshRoute, showToast],
  );

  return (
    <AppContext.Provider value={context}>
      <AppHeader participants={participants} status={status} />
      <RouteView refresh={route.refresh} state={route.state} />
      <div className="toast-region" data-toasts="" role="status" aria-live="polite">
        {toasts.map((toast) => (
          <div className={`toast toast--${toast.kind}`} key={toast.id}>
            {toast.message}
          </div>
        ))}
      </div>
    </AppContext.Provider>
  );
}

function RouteView({
  refresh,
  state,
}: {
  readonly refresh: () => void;
  readonly state:
    | { readonly status: "loading"; readonly data: RouteModel | undefined }
    | { readonly status: "success"; readonly data: RouteModel }
    | {
        readonly status: "failure";
        readonly data: RouteModel | undefined;
        readonly error: ApiError;
      };
}): React.JSX.Element {
  const model = state.data;
  if (model === undefined) {
    if (state.status === "failure") {
      return (
        <main className="fatal-layout" id="app" tabIndex={-1}>
          <section>
            <p className="eyebrow">Runtime failure</p>
            <h1>Jot could not open.</h1>
            <p>{state.error.message}</p>
            <Button variant="primary" data-retry="" onClick={refresh} type="button">
              Try again
            </Button>
          </section>
        </main>
      );
    }
    return <main aria-busy="true" className="route-loading" id="app" tabIndex={-1} />;
  }
  switch (model.screen) {
    case "authentication":
      return <AuthenticationScreen api={model.api} methods={model.methods} mode={model.mode} />;
    case "workspace":
      return <WorkspaceScreen api={model.api} initialCatalog={model.catalog} />;
    case "reader":
      return (
        <Suspense fallback={<main className="route-loading" id="app" />}>
          <ReaderScreen document={model.document} shared={model.shared} />
        </Suspense>
      );
    case "editor":
      return (
        <Suspense fallback={<main className="route-loading" id="app" />}>
          <EditorScreen
            api={model.api}
            capabilityToken={model.capabilityToken}
            document={model.document}
            key={`${model.document.metadata.id}:${model.shared ? "shared" : "workspace"}`}
            shared={model.shared}
          />
        </Suspense>
      );
  }
}

function loadRoute(url: URL): Effect.Effect<RouteModel, ApiError> {
  const capabilityToken = url.searchParams.get("cap") ?? undefined;
  const api = makeApiClient(capabilityToken);
  const shared = /^\/share\/([^/]+)(?:\/(edit))?\/?$/u.exec(url.pathname);
  const documentRoute = /^\/documents\/([^/]+)(?:\/(edit))?\/?$/u.exec(url.pathname);
  if (shared?.[1] !== undefined) {
    return loadDocumentRoute(
      api,
      capabilityToken,
      decodeURIComponent(shared[1]),
      shared[2] === "edit" ? "editor" : "reader",
      true,
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
  return api.authenticationStatus.pipe(
    Effect.flatMap((authentication) => {
      if (authentication.needsSetup) {
        const model: RouteModel = {
          api,
          capabilityToken,
          methods: authentication.authenticationMethods,
          mode: "setup",
          screen: "authentication",
        };
        return Effect.succeed(model);
      }
      if (!authentication.authenticated) {
        const model: RouteModel = {
          api,
          capabilityToken,
          methods: authentication.authenticationMethods,
          mode: "login",
          screen: "authentication",
        };
        return Effect.succeed(model);
      }
      return api.listDocuments().pipe(
        Effect.map((catalog): RouteModel => ({
          api,
          capabilityToken,
          catalog,
          screen: "workspace",
        })),
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
        message: "Jot could not load this view.",
        retryable: true,
        status: 0,
      }),
    try: screen === "editor" ? loadEditorScreen : loadReaderScreen,
  });
  return Effect.all([api.readDocument(documentId), preload], { concurrency: "unbounded" }).pipe(
    Effect.map(([document]): RouteModel => ({
      api,
      capabilityToken,
      document,
      screen,
      shared,
    })),
  );
}

function isApplicationUrl(url: URL): boolean {
  return (
    url.origin === location.origin &&
    (url.pathname === "/" ||
      url.pathname.startsWith("/documents/") ||
      url.pathname.startsWith("/share/"))
  );
}
