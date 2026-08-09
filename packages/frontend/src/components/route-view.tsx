import { lazy, Suspense } from "react";

import type {
  AuthenticationStatus,
  CatalogResponse,
  DocumentResponse,
} from "@earendil-works/inkling-protocol";

import type { ApiClientService, ApiError } from "../api.ts";
import type { FrontmatterVocabulary } from "../frontmatter-completion.ts";
import type { EffectQueryState } from "../effect-hooks.ts";
import { LabelsScreen } from "../labels-screen.tsx";
import { TrashScreen } from "../trash-screen.tsx";
import { WorkspaceScreen } from "../workspace-screen.tsx";
import { Button } from "./button.tsx";
import { SharePasswordScreen } from "./share-password-screen.tsx";

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
      readonly document: DocumentResponse;
      readonly frontmatterVocabulary: FrontmatterVocabulary;
      readonly publicDocument: boolean;
      readonly screen: "editor" | "reader";
      readonly shared: boolean;
    })
  | (RouteBase & {
      readonly catalog: CatalogResponse;
      readonly publicCatalog: boolean;
      readonly screen: "labels";
      readonly selectedLabel: string | undefined;
    })
  | (RouteBase & {
      readonly catalog: CatalogResponse;
      readonly publicCatalog: boolean;
      readonly screen: "workspace";
    })
  | (RouteBase & {
      readonly catalog: CatalogResponse;
      readonly screen: "trash";
    })
  | (RouteBase & {
      readonly documentId: string;
      readonly screen: "share-password";
    });

export interface RouteViewProps {
  readonly navigationKey: number;
  readonly refresh: () => void;
  readonly state: EffectQueryState<RouteModel, ApiError>;
}

export function RouteView({ navigationKey, refresh, state }: RouteViewProps): React.JSX.Element {
  const model = state.data;
  if (model === undefined) {
    if (state.status === "failure") {
      return (
        <main className="fatal-layout" id="app" tabIndex={-1}>
          <section>
            <p className="eyebrow">Runtime failure</p>
            <h1>Inkling could not open.</h1>
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
    case "share-password":
      return (
        <SharePasswordScreen api={model.api} documentId={model.documentId} onUnlocked={refresh} />
      );
    case "workspace":
      return (
        <WorkspaceScreen
          api={model.api}
          initialCatalog={model.catalog}
          key={navigationKey}
          publicCatalog={model.publicCatalog}
          showTrash={model.account?.role === "administrator"}
        />
      );
    case "trash":
      return <TrashScreen api={model.api} initialCatalog={model.catalog} />;
    case "labels":
      return (
        <LabelsScreen
          catalog={model.catalog}
          publicCatalog={model.publicCatalog}
          selectedLabel={model.selectedLabel}
        />
      );
    case "reader":
      return (
        <Suspense fallback={<main aria-busy="true" className="route-loading" id="app" />}>
          <ReaderScreen
            document={model.document}
            publicDocument={model.publicDocument}
            shared={model.shared}
          />
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
            frontmatterVocabulary={model.frontmatterVocabulary}
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
