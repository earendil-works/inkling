import { Suspense, use } from "react";

import { Button, Container, EmptyState, Layout } from "@earendil-works/elanor-react";

import type { ApiError } from "../api.ts";
import { useCurrentUrl } from "../app-context.tsx";
import type { EditorScreen as EditorScreenComponent } from "../editor-screen.tsx";
import type { EffectQueryState } from "../effect-hooks.ts";
import { LabelsScreen } from "../labels-screen.tsx";
import type { ReaderScreen as ReaderScreenComponent } from "../reader-screen.tsx";
import type { RouteModel } from "../route-data.ts";
import { TrashScreen } from "../trash-screen.tsx";
import { signInHref } from "../ui.ts";
import { WorkspaceScreen } from "../workspace-screen.tsx";
import { ButtonLink } from "./button-link.tsx";
import styles from "./route-view.module.css";
import { SharePasswordScreen } from "./share-password-screen.tsx";

/** Thrown while server rendering the editor, which only renders in the browser. */
export const clientOnlyDigest = "inkling-client-only";

interface ScreenLoader<T> {
  /** The screen, once its code has loaded. */
  readonly loaded: () => T | undefined;
  /** Loads the screen's code once; after a failure, the next call tries again. */
  readonly load: () => Promise<T>;
}

function screenLoader<T>(load: () => Promise<T>): ScreenLoader<T> {
  let loaded: T | undefined;
  let loading: Promise<T> | undefined;
  return {
    load: () =>
      (loading ??= load().then(
        (screen) => (loaded = screen),
        (error: unknown) => {
          loading = undefined;
          throw error;
        },
      )),
    loaded: () => loaded,
  };
}

// The editor needs the DOM and a live collaboration session, so the server
// renders its loading state and leaves the editor to the browser.
const editorScreen = screenLoader<typeof EditorScreenComponent>(
  import.meta.env.SSR
    ? () =>
        Promise.reject(
          Object.assign(new Error("The editor renders in the browser."), {
            digest: clientOnlyDigest,
          }),
        )
    : () => import("../editor-screen.tsx").then((module) => module.EditorScreen),
);
const readerScreen = screenLoader<typeof ReaderScreenComponent>(() =>
  import("../reader-screen.tsx").then((module) => module.ReaderScreen),
);

// Routes load their screen before rendering it, so it usually renders at
// once; otherwise it suspends until its code arrives.
function EditorScreen(
  props: React.ComponentProps<typeof EditorScreenComponent>,
): React.JSX.Element {
  const Screen = editorScreen.loaded() ?? use(editorScreen.load());
  return <Screen {...props} />;
}

function ReaderScreen(
  props: React.ComponentProps<typeof ReaderScreenComponent>,
): React.JSX.Element {
  const Screen = readerScreen.loaded() ?? use(readerScreen.load());
  return <Screen {...props} />;
}

export interface RouteViewProps {
  readonly navigationKey: number;
  readonly refresh: () => void;
  readonly state: EffectQueryState<RouteModel, ApiError>;
}

export function RouteView({ navigationKey, refresh, state }: RouteViewProps): React.JSX.Element {
  const model = state.data;
  if (model === undefined) {
    if (state.status === "failure") {
      return <FailureScreen error={state.error} refresh={refresh} />;
    }
    return <LoadingScreen />;
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
        <Suspense fallback={<LoadingScreen />}>
          <ReaderScreen
            api={model.api}
            document={model.document}
            publicDocument={model.publicDocument}
            references={model.references}
            shared={model.shared}
          />
        </Suspense>
      );
    case "editor":
      return (
        <Suspense fallback={<LoadingScreen />}>
          <EditorScreen
            account={model.account}
            api={model.api}
            capabilityToken={model.capabilityToken}
            document={model.document}
            frontmatterVocabulary={model.frontmatterVocabulary}
            key={`${model.document.metadata.id}:${model.shared ? "shared" : "workspace"}`}
            references={model.references}
            shared={model.shared}
          />
        </Suspense>
      );
  }
}

function LoadingScreen(): React.JSX.Element {
  return <Layout.Main aria-busy="true" id="app" tabIndex={-1} />;
}

function FailureScreen({
  error,
  refresh,
}: {
  readonly error: ApiError;
  readonly refresh: () => void;
}): React.JSX.Element {
  const url = useCurrentUrl();
  const signIn = error.code === "sign_in_required";
  const denied = signIn || error.code === "forbidden";
  return (
    <Layout.Main className={styles["fatal"]} id="app" tabIndex={-1}>
      <Container>
        <EmptyState.Root>
          <EmptyState.Body>
            <EmptyState.Copy>
              <EmptyState.Title level={1}>
                {denied ? "You don’t have access." : "Inkling could not open."}
              </EmptyState.Title>
              <EmptyState.Description>{error.message}</EmptyState.Description>
            </EmptyState.Copy>
            {denied && !signIn ? null : (
              <EmptyState.Actions>
                {signIn ? (
                  <ButtonLink data-sign-in="" href={signInHref(url)}>
                    Sign in
                  </ButtonLink>
                ) : (
                  <Button data-retry="" onClick={refresh}>
                    Try again
                  </Button>
                )}
              </EmptyState.Actions>
            )}
          </EmptyState.Body>
        </EmptyState.Root>
      </Container>
    </Layout.Main>
  );
}

export function preloadDocumentScreen(screen: "editor" | "reader"): Promise<unknown> {
  return screen === "editor" ? editorScreen.load() : readerScreen.load();
}
