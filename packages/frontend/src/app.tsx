import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Effect } from "effect";

import type { PresenceDto } from "@earendil-works/jot-protocol";

import { ApiError, makeApiClient } from "./api.ts";
import type { ApiClientService } from "./api.ts";
import { AppContext } from "./app-context.tsx";
import type { AppContextValue, AppStatus, ToastKind } from "./app-context.tsx";
import { AppHeader } from "./components/app-header.tsx";
import { preloadDocumentScreen, RouteView } from "./components/route-view.tsx";
import type { RouteModel } from "./components/route-view.tsx";
import { ToastRegion } from "./components/toast-region.tsx";
import type { ToastController } from "./components/toast-region.tsx";
import { useEffectQuery } from "./effect-hooks.ts";
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
  const [status, setStatus] = useState<AppStatus>({
    label: "Starting Effect runtime…",
    state: "connecting",
  });
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
      <ToastRegion ref={toastRef} />
    </AppContext.Provider>
  );
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
    try: () => preloadDocumentScreen(screen),
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
