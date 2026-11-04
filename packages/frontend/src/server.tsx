import { renderToReadableStream } from "react-dom/server.edge";
import { Effect, Either } from "effect";

import { makeApiClient } from "./api.ts";
import type { ApiTransport } from "./api.ts";
import { App, routePath, routeTitle } from "./app.tsx";
import { clientOnlyDigest, preloadDocumentScreen } from "./components/route-view.tsx";
import {
  documentRenderSettings,
  markdownRenderKey,
  PrerenderedMarkdownContext,
  renderMarkdown,
} from "./markdown.tsx";
import type { MarkdownRenderResult } from "./markdown.tsx";
import { initialRouteElementId } from "./route-data.ts";
import type { InitialRoute, PrerenderedMarkdown, RouteModel } from "./route-data.ts";
import { isApplicationPath, loadRoute } from "./route-loader.ts";
import type { RouteEnvironment } from "./route-loader.ts";
import type * as Contract from "./server-contract.ts";

interface RouteAssets {
  readonly modules: readonly string[];
  readonly styles: readonly string[];
}

/** The application shell, split where the server inserts the rendered route. */
interface Shell {
  /** Everything before `</head>`, without the title. */
  readonly head: string;
  /** From `</head>` through the opening of the root element. */
  readonly bodyStart: string;
  /** The root's static content, shown when the route cannot be rendered. */
  readonly fallbackRoot: string;
  /** From the root's closing tag to the end. */
  readonly end: string;
  readonly routeAssets: Readonly<Partial<Record<"editor" | "reader", RouteAssets>>>;
}

const rootStartMarker = "<!--inkling-root-->";
const rootEndMarker = "<!--/inkling-root-->";
const routeAssetsPattern = /<!--inkling-route-assets:(.*?)-->/su;
const titlePattern = /<title>[\s\S]*?<\/title>/u;

let cachedShell: { readonly shell: Shell | undefined; readonly template: string } | undefined;

export const renderApplication: typeof Contract.renderApplication = ({
  fetch,
  request,
  template,
}) => {
  const url = new URL(request.url);
  if (!isApplicationPath(url.pathname)) return undefined;
  const shell = parseShell(template);
  if (shell === undefined) return undefined;

  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      // The head references the scripts and styles every page needs, so the
      // browser loads them while the route's data loads.
      controller.enqueue(encoder.encode(shell.head));
      const rendered = await renderRoute(url, request, fetch, shell);
      controller.enqueue(encoder.encode(rendered));
      controller.close();
    },
  });
  return new Response(request.method === "HEAD" ? null : body, {
    headers: {
      // Pages carry the reader's own data; never store them in shared caches.
      "Cache-Control": "private, no-cache",
      "Content-Type": "text/html; charset=UTF-8",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
    },
  });
};

async function renderRoute(
  url: URL,
  request: Request,
  fetch: Contract.RenderApplicationOptions["fetch"],
  shell: Shell,
): Promise<string> {
  const fallback = `<title>Inkling</title></head>${shell.bodyStart}${shell.fallbackRoot}${shell.end}`;
  try {
    const environment: RouteEnvironment = {
      api: (capabilityToken) => makeApiClient(capabilityToken, serverTransport(request, fetch)),
      // The editor only renders in the browser.
      preloadDocumentScreen: (screen) =>
        screen === "reader" ? preloadDocumentScreen(screen) : Promise.resolve(),
    };
    const loaded = await Effect.runPromise(Effect.either(loadRoute(url, environment)));
    // Failures render in the browser, which retries and explains them.
    if (Either.isLeft(loaded)) return fallback;
    const model = loaded.right;
    const markdown = await prerenderMarkdown(model);
    const path = routePath(url);
    const stream = await renderToReadableStream(
      <PrerenderedMarkdownContext
        value={new Map(markdown.map(({ key, rendered }) => [key, rendered]))}
      >
        <App initialRoute={{ model, path }} initialUrl={url} routeEnvironment={environment} />
      </PrerenderedMarkdownContext>,
      {
        onError: (error) => {
          if (digestOf(error) === clientOnlyDigest) return clientOnlyDigest;
          console.error("Inkling could not render a page", errorMessage(error));
          return undefined;
        },
        // The page is sent whole, so keep large boundaries in place instead
        // of moving them behind the shell with inline scripts.
        progressiveChunkSize: Number.POSITIVE_INFINITY,
      },
    );
    await stream.allReady;
    const html = await new Response(stream).text();
    const { api: _api, ...route } = model;
    const initial: InitialRoute = {
      href: path,
      markdown: markdown.map(({ key, rendered }) => serializeMarkdown(key, rendered)),
      route,
    };
    const assets =
      model.screen === "editor" || model.screen === "reader"
        ? shell.routeAssets[model.screen]
        : undefined;
    return [
      `<title>${escapeHtml(routeTitle(model))}</title>`,
      ...(assets?.styles ?? []).map(
        (href) => `<link rel="stylesheet" crossorigin href="${escapeHtml(href)}">`,
      ),
      ...(assets?.modules ?? []).map(
        (href) => `<link rel="modulepreload" crossorigin href="${escapeHtml(href)}">`,
      ),
      "</head>",
      shell.bodyStart,
      html,
      shell.end.replace(
        "</body>",
        `<script type="application/json" id="${initialRouteElementId}">${scriptJson(initial)}</script></body>`,
      ),
    ].join("");
  } catch (error) {
    console.error("Inkling could not render a page", errorMessage(error));
    return fallback;
  }
}

function serverTransport(
  request: Request,
  fetch: Contract.RenderApplicationOptions["fetch"],
): ApiTransport {
  const cookie = request.headers.get("Cookie");
  return (path, init) => {
    const headers = new Headers(init.headers);
    if (cookie !== null) headers.set("Cookie", cookie);
    return fetch(new Request(new URL(path, request.url), { ...init, headers }));
  };
}

interface Prerendered {
  readonly key: string;
  readonly rendered: MarkdownRenderResult;
}

/** Renders the Markdown the reader shows, since rendering it is asynchronous. */
async function prerenderMarkdown(model: RouteModel): Promise<readonly Prerendered[]> {
  if (model.screen !== "reader") return [];
  const source = model.document.body;
  const settings = documentRenderSettings(model.document.metadata, model.references);
  const rendered = await Effect.runPromise(Effect.either(renderMarkdown(source, true, settings)));
  return Either.isRight(rendered)
    ? [
        {
          key: markdownRenderKey(source, true, settings),
          rendered: rendered.right,
        },
      ]
    : [];
}

function serializeMarkdown(key: string, rendered: MarkdownRenderResult): PrerenderedMarkdown {
  return {
    frontmatter: rendered.frontmatter,
    headings: rendered.headings,
    html: rendered.html,
    key,
    references: rendered.references.map((reference) => reference.source),
    title: rendered.title,
  };
}

function parseShell(template: string): Shell | undefined {
  if (cachedShell?.template === template) return cachedShell.shell;
  const shell = splitShell(template);
  cachedShell = { shell, template };
  return shell;
}

function splitShell(template: string): Shell | undefined {
  const assetsMatch = routeAssetsPattern.exec(template);
  const source = template.replace(routeAssetsPattern, "").replace(titlePattern, "");
  const headEnd = source.indexOf("</head>");
  const rootStart = source.indexOf(rootStartMarker);
  const rootEnd = source.indexOf(rootEndMarker);
  if (headEnd === -1 || rootStart < headEnd || rootEnd < rootStart) return undefined;
  let routeAssets: Shell["routeAssets"] = {};
  try {
    routeAssets =
      assetsMatch?.[1] === undefined ? {} : (JSON.parse(assetsMatch[1]) as Shell["routeAssets"]);
  } catch {
    routeAssets = {};
  }
  // React hydrates the root's children, so no whitespace may surround them.
  return {
    bodyStart: source.slice(headEnd + "</head>".length, rootStart).trimEnd(),
    end: source.slice(rootEnd + rootEndMarker.length).trimStart(),
    fallbackRoot: source.slice(rootStart + rootStartMarker.length, rootEnd),
    head: source.slice(0, headEnd),
    routeAssets,
  };
}

/** JSON that cannot close or comment out its script element. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function digestOf(error: unknown): unknown {
  return typeof error === "object" && error !== null && "digest" in error
    ? (error as { readonly digest?: unknown }).digest
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
