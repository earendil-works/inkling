import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Layout } from "@earendil-works/elanor-react";

import type { PresenceDto } from "@earendil-works/inkling-protocol";

import { makeApiClient, makeAuthenticationCache } from "./api.ts";
import { AppContext, LocationContext } from "./app-context.tsx";
import type { AppContextValue, AppStatus, HeaderDocument, ToastKind } from "./app-context.tsx";
import { AppHeader } from "./components/app-header.tsx";
import type { BreadcrumbItem } from "./components/app-header.tsx";
import { preloadDocumentScreen, RouteView } from "./components/route-view.tsx";
import { ToastRegion } from "./components/toast-region.tsx";
import type { ToastController } from "./components/toast-region.tsx";
import { useEffectQuery } from "./effect-hooks.ts";
import { installClientRouter } from "./navigation.ts";
import type { ClientRouter, NavigateOptions } from "./navigation.ts";
import type { RouteData, RouteModel } from "./route-data.ts";
import { isApplicationPath, loadRoute } from "./route-loader.ts";
import type { RouteEnvironment } from "./route-loader.ts";
import { WIKI_PATH, formatRfcNumber, isWikiPage } from "./ui.ts";

const browserAuthentication = makeAuthenticationCache();

const browserRouteEnvironment: RouteEnvironment = {
  api: (capabilityToken) => makeApiClient(capabilityToken, undefined, browserAuthentication),
  preloadDocumentScreen,
};

interface LocationState {
  readonly generation: number;
  readonly url: URL;
}

export interface AppProps {
  /** The route the page was server-rendered with; used instead of loading it again. */
  readonly initialRoute?: { readonly path: string; readonly model: RouteModel } | undefined;
  /** The location to render; the browser's own location by default. */
  readonly initialUrl?: URL | undefined;
  readonly routeEnvironment?: RouteEnvironment | undefined;
}

export function App({
  initialRoute,
  initialUrl,
  routeEnvironment = browserRouteEnvironment,
}: AppProps): React.JSX.Element {
  const [locationState, setLocationState] = useState<LocationState>(() => ({
    generation: 0,
    url: initialUrl ?? new URL(location.href),
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

  const routeEffect = useMemo(
    () => loadRoute(locationState.url, routeEnvironment),
    [locationState.url, routeEnvironment],
  );
  const route = useEffectQuery(
    routeEffect,
    routeQueryKey(routePath(locationState.url), locationState.generation),
    initialRoute === undefined
      ? undefined
      : { data: initialRoute.model, key: routeQueryKey(initialRoute.path, 0) },
  );
  const navigating = route.state.status === "loading";
  const breadcrumbs = breadcrumbsForRoute(route.state.data, locationState.url, headerDocument);
  const pageTitle =
    route.state.data?.screen === "editor" &&
    headerDocument?.id === route.state.data.document.metadata.id
      ? headerDocument.title
      : routeTitle(route.state.data);

  useEffect(() => {
    document.title = pageTitle;
  }, [pageTitle]);
  const wikiMode = route.state.data?.screen === "reader" && route.state.data.wiki !== undefined;
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
      <LocationContext.Provider value={locationState.url}>
        <Layout.Root>
          {/* Wiki pages read like a documentation site, with their own navigation. */}
          {wikiMode ? null : (
            <AppHeader
              account={route.state.data?.account}
              api={route.state.data?.api}
              breadcrumbs={breadcrumbs}
              navigating={navigating}
              participants={participants}
              status={status}
            />
          )}
          <RouteView
            navigationKey={locationState.generation}
            refresh={route.refresh}
            state={route.state}
          />
        </Layout.Root>
      </LocationContext.Provider>
      <ToastRegion ref={toastRef} />
    </AppContext.Provider>
  );
}

/** The part of a URL that selects a route; fragments only scroll. */
export function routePath(url: URL): string {
  return `${url.pathname}${url.search}`;
}

function routeQueryKey(path: string, generation: number): string {
  return `${path}:${generation}`;
}

/** The document title for a route. */
export function routeTitle(model: RouteData | undefined): string {
  return model?.screen === "editor" || model?.screen === "reader"
    ? model.document.metadata.title
    : "Inkling";
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
    rfc === undefined ? document.title : `${formatRfcNumber(rfc)} - ${document.title}`;
  const documentBreadcrumb: BreadcrumbItem = {
    href:
      model.screen === "editor"
        ? `${url.pathname.replace(/\/edit\/?$/u, "")}${url.search}`
        : undefined,
    label: documentLabel,
    truncate: true,
  };
  const parents: readonly BreadcrumbItem[] =
    !deleted && isWikiPage(document) ? [section, { href: WIKI_PATH, label: "Wiki" }] : [section];
  return model.screen === "editor"
    ? [home, ...parents, documentBreadcrumb, { label: "Edit" }]
    : [home, ...parents, documentBreadcrumb];
}

function isApplicationUrl(url: URL): boolean {
  return url.origin === location.origin && isApplicationPath(url.pathname);
}
