import { createRoot, hydrateRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { Effect, Either, Schema } from "effect";

import { parseReference } from "@earendil-works/inkling-renderer";

import { makeApiClient } from "./api.ts";
import { App, routePath } from "./app.tsx";
import { clientOnlyDigest } from "./components/route-view.tsx";
import { browserRuntime } from "./effect-runtime.ts";
import { PrerenderedMarkdownContext } from "./markdown.tsx";
import type { MarkdownRenderResult } from "./markdown.tsx";
import { InitialRouteSchema, initialRouteElementId } from "./route-data.ts";
import type { InitialRoute } from "./route-data.ts";

const rootElement = document.querySelector<HTMLElement>("#root");
if (rootElement === null) throw new Error("Missing React root element.");

const root = mount(rootElement, readInitialRoute());

window.addEventListener("beforeunload", () => {
  root.unmount();
  Effect.runFork(browserRuntime.disposeEffect);
});

function mount(container: HTMLElement, initial: InitialRoute | undefined): Root {
  const url = new URL(location.href);
  if (initial === undefined || initial.href !== routePath(url)) {
    // Not server rendered, or the page moved since; render from scratch.
    if (initial !== undefined) container.replaceChildren();
    const created = createRoot(container);
    created.render(<App />);
    return created;
  }
  const markdown = new Map<string, MarkdownRenderResult>(
    initial.markdown.map(({ frontmatter, headings, html, key, references, title }) => [
      key,
      {
        frontmatter,
        headings,
        html,
        protectedLinks: [],
        references: references.flatMap((source, index) => {
          const reference = parseReference(source);
          return reference === undefined ? [] : [{ ...reference, index, source }];
        }),
        title,
      },
    ]),
  );
  return hydrateRoot(
    container,
    <PrerenderedMarkdownContext value={markdown}>
      <App
        initialRoute={{
          model: { ...initial.route, api: makeApiClient(initial.route.capabilityToken) },
          path: initial.href,
        }}
        initialUrl={url}
      />
    </PrerenderedMarkdownContext>,
    {
      onRecoverableError: (error) => {
        // The server leaves client-only views, such as the editor, to the browser.
        if (hasDigest(error, clientOnlyDigest)) return;
        reportError(error);
      },
    },
  );
}

function readInitialRoute(): InitialRoute | undefined {
  const element = document.getElementById(initialRouteElementId);
  if (element === null) return undefined;
  element.remove();
  const decoded = Schema.decodeUnknownEither(Schema.parseJson(InitialRouteSchema))(
    element.textContent ?? "",
  );
  return Either.getOrUndefined(decoded);
}

function hasDigest(value: unknown, digest: string): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "digest" in value &&
    (value as { readonly digest?: unknown }).digest === digest
  );
}
