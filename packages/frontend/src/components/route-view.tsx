import { lazy, Suspense } from "react";

import type {
  AuthenticationStatus,
  CatalogResponse,
  DocumentResponse,
} from "@earendil-works/jot-protocol";

import type { ApiClientService, ApiError } from "../api.ts";
import { AuthenticationScreen } from "../auth-screen.tsx";
import type { EffectQueryState } from "../effect-hooks.ts";
import { LabelsScreen } from "../labels-screen.tsx";
import { WorkspaceScreen } from "../workspace-screen.tsx";
import { Button } from "./button.tsx";

const loadEditorScreen = () =>
  import("../editor-screen.tsx").then(({ EditorScreen }) => ({ default: EditorScreen }));
const loadReaderScreen = () =>
  import("../reader-screen.tsx").then(({ ReaderScreen }) => ({ default: ReaderScreen }));
const EditorScreen = lazy(loadEditorScreen);
const ReaderScreen = lazy(loadReaderScreen);

interface RouteBase {
  readonly account?: NonNullable<AuthenticationStatus["principal"]> | undefined;
  readonly api: ApiClientService;
  readonly capabilityToken: string | undefined;
}

export type RouteModel =
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
  | (RouteBase & {
      readonly catalog: CatalogResponse;
      readonly screen: "labels";
      readonly selectedLabel: string | undefined;
    })
  | (RouteBase & { readonly catalog: CatalogResponse; readonly screen: "workspace" });

export interface RouteViewProps {
  readonly refresh: () => void;
  readonly state: EffectQueryState<RouteModel, ApiError>;
}

export function RouteView({ refresh, state }: RouteViewProps): React.JSX.Element {
  const model = state.data;
  if (model === undefined) {
    if (state.status === "failure") {
      return (
        <main className="fatal-layout" id="app" tabIndex={-1}>
          <section>
            <p className="eyebrow">Runtime failure</p>
            <h1>Jot could not open.</h1>
            <p>{state.error.message}</p>
            <Button variant="primary" data-retry="" onClick={refresh}>
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
    case "labels":
      return <LabelsScreen catalog={model.catalog} selectedLabel={model.selectedLabel} />;
    case "reader":
      return (
        <Suspense fallback={<main aria-busy="true" className="route-loading" id="app" />}>
          <ReaderScreen document={model.document} shared={model.shared} />
        </Suspense>
      );
    case "editor":
      return (
        <Suspense fallback={<main aria-busy="true" className="route-loading" id="app" />}>
          <EditorScreen
            account={model.account}
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

export function preloadDocumentScreen(screen: "editor" | "reader"): Promise<unknown> {
  return screen === "editor" ? loadEditorScreen() : loadReaderScreen();
}
