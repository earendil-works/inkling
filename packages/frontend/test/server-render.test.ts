import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type {
  AuthenticationStatus,
  CatalogResponse,
  DocumentMetadataDto,
  DocumentResponse,
} from "@earendil-works/inkling-protocol";

import type * as Contract from "../src/server-contract.ts";

// The test script builds the renderer and the shell before running tests.
const { renderApplication } = (await import(
  new URL("../dist-server/server.js", import.meta.url).href
)) as typeof Contract;
const template = await readFile(new URL("../dist/index.html", import.meta.url), "utf8");

const metadata: DocumentMetadataDto = {
  approvers: [],
  authors: [{ displayName: "Ada Lovelace", email: "ada@example.com", id: "ada@example.com" }],
  createdAt: "2026-01-01T00:00:00.000Z",
  headRevision: 4,
  id: "doc_0123456789",
  labels: ["platform"],
  lifecycleState: "discussion",
  publishedRevision: 4,
  relatedDocuments: [],
  reviewers: [],
  rfcNumber: 7,
  sharing: { access: "disabled", generation: 0 },
  title: "Server </script> rendering",
  updatedAt: "2026-01-02T00:00:00.000Z",
  visibility: "private",
};

const document: DocumentResponse = {
  body: "# Server rendering\n\n## Motivation\n\nPages render **before** scripts load.\n\n```ts\nconst answer = 42;\n```\n",
  comments: { revision: 0, threads: [] },
  metadata,
  sequence: 4,
};

const authenticated: AuthenticationStatus = {
  authenticated: true,
  principal: { displayName: "Ada Lovelace", email: "ada@example.com", id: "ada", role: "member" },
};

interface RecordedRequest {
  readonly cookie: string | null;
  readonly path: string;
}

function api(
  responses: Readonly<Record<string, unknown>>,
  requests: RecordedRequest[] = [],
): Contract.RenderApplicationOptions["fetch"] {
  return (request) => {
    const url = new URL(request.url);
    const path = `${url.pathname}${url.search}`;
    requests.push({ cookie: request.headers.get("Cookie"), path });
    const body = responses[path];
    return Promise.resolve(
      body === undefined
        ? Response.json(
            { code: "not_found", message: "Missing.", retryable: false },
            { status: 404 },
          )
        : Response.json(body),
    );
  };
}

function render(
  path: string,
  fetch: Contract.RenderApplicationOptions["fetch"],
  init?: RequestInit,
): Response | undefined {
  return renderApplication({
    fetch,
    request: new Request(`https://inkling.test${path}`, init),
    template,
  });
}

function initialRoute(html: string): unknown {
  const json = /<script type="application\/json" id="inkling-initial-route">(.*?)<\/script>/su.exec(
    html,
  )?.[1];
  assert.ok(json, "the page embeds the route it was rendered with");
  return JSON.parse(json);
}

test("reader pages render the document and embed its data with the request's credentials", async () => {
  const requests: RecordedRequest[] = [];
  const response = render(
    `/documents/${metadata.id}`,
    api(
      {
        "/api/auth/status": authenticated,
        [`/api/documents/${metadata.id}?published=true`]: document,
      },
      requests,
    ),
    { headers: { Cookie: "inkling_session=session" } },
  );
  assert.ok(response);
  assert.equal(response.headers.get("Cache-Control"), "private, no-cache");
  assert.match(response.headers.get("Content-Type") ?? "", /^text\/html/u);
  const html = await response.text();

  assert.ok(requests.length > 0);
  assert.ok(requests.every((request) => request.cookie === "inkling_session=session"));
  assert.match(html, /<title>Server &lt;\/script&gt; rendering<\/title>/u);
  assert.match(
    html,
    /<h2 id="motivation"[^>]*><span class="inkling-section-number">1<\/span> Motivation <a class="inkling-heading-anchor" href="#motivation"/u,
  );
  assert.match(html, /<strong>before<\/strong>/u);
  // Highlighted code is part of the page instead of loading after the script.
  assert.match(html, /class="[^"]*tok-/u);
  assert.match(html, /<link rel="stylesheet" crossorigin href="\/assets\/[^"]+\.css">/u);
  assert.match(
    html,
    /<link rel="modulepreload" crossorigin href="\/assets\/reader-screen-[^"]+\.js">/u,
  );
  assert.doesNotMatch(html, /INKLING AGENT HANDOFF<\/h1>/u);
  assert.doesNotMatch(html, /inkling-route-assets/u);
  // The root holds only the rendered application, which hydration requires.
  assert.match(html, /<div id="root"><div class=/u);
  // Embedded data cannot close its script element.
  assert.equal(html.match(/<\/script>/gu)?.length, html.match(/<script/gu)?.length);

  const embedded = initialRoute(html) as {
    href: string;
    markdown: readonly { readonly html: string }[];
    route: { readonly document: DocumentResponse; readonly screen: string };
  };
  assert.equal(embedded.href, `/documents/${metadata.id}`);
  assert.equal(embedded.route.screen, "reader");
  assert.equal(embedded.route.document.metadata.title, metadata.title);
  assert.equal(embedded.markdown.length, 1);
});

test("RFC pages resolve the number and ask for the authentication status once", async () => {
  const requests: RecordedRequest[] = [];
  const response = render(
    "/rfc/0007",
    api(
      {
        "/api/auth/status": authenticated,
        "/api/documents?q=rfc%3A7": { documents: [{ excerpt: "", metadata }], people: [] },
        [`/api/documents/${metadata.id}?published=true`]: document,
      },
      requests,
    ),
  );
  assert.ok(response);
  assert.match(await response.text(), /data-reader=""/u);
  assert.equal(requests.filter((request) => request.path === "/api/auth/status").length, 1);
});

test("RFC pages look the number up while the authentication status loads", async () => {
  const lookup = Promise.withResolvers<void>();
  const respond = api({
    "/api/auth/status": authenticated,
    "/api/documents?q=rfc%3A7": { documents: [{ excerpt: "", metadata }], people: [] },
    [`/api/documents/${metadata.id}?published=true`]: document,
  });
  const response = render("/rfc/0007", async (request) => {
    const url = new URL(request.url);
    if (url.pathname === "/api/documents" && url.search === "?q=rfc%3A7") lookup.resolve();
    // The status only answers once the lookup was sent, so asking for
    // them one after the other would never finish.
    if (url.pathname === "/api/auth/status") await lookup.promise;
    return respond(request);
  });
  assert.ok(response);
  assert.match(await response.text(), /data-reader=""/u);
});

test("workspace pages render the catalog for the query in the address", async () => {
  const catalog: CatalogResponse = {
    documents: [{ excerpt: "Pages render before scripts load.", metadata }],
    people: [],
  };
  const response = render(
    "/?q=label%3Aplatform",
    api({
      "/api/auth/status": authenticated,
      "/api/documents?q=label%3Aplatform": catalog,
    }),
  );
  assert.ok(response);
  const html = await response.text();
  assert.match(html, /data-catalog-document-id="doc_0123456789"/u);
  assert.match(html, /value="label:platform"/u);
  assert.doesNotMatch(html, /modulepreload[^>]+reader-screen/u);
  assert.equal((initialRoute(html) as { route: { screen: string } }).route.screen, "workspace");
});

test("editor pages leave the editor to the browser but embed its data", async () => {
  const requests: RecordedRequest[] = [];
  const response = render(
    `/documents/${metadata.id}/edit`,
    api(
      {
        "/api/auth/status": authenticated,
        "/api/documents?q=": { documents: [], people: [] },
        [`/api/documents/${metadata.id}`]: document,
      },
      requests,
    ),
  );
  assert.ok(response);
  const html = await response.text();
  assert.match(html, /<!--\$!--><template data-dgst="inkling-client-only">/u);
  assert.match(html, /modulepreload[^>]+editor-screen-/u);
  const embedded = initialRoute(html) as {
    route: { frontmatterVocabulary: { labels: readonly string[] }; screen: string };
  };
  assert.equal(embedded.route.screen, "editor");
  assert.deepEqual(embedded.route.frontmatterVocabulary.labels, ["platform"]);
  // The editor loads the catalog for frontmatter completion after it opens.
  assert.deepEqual(requests.map((request) => request.path).toSorted(), [
    "/api/auth/status",
    `/api/documents/${metadata.id}`,
  ]);
});

test("pages whose data cannot load fall back to the static shell", async () => {
  const response = render(`/documents/${metadata.id}`, api({ "/api/auth/status": authenticated }));
  assert.ok(response);
  const html = await response.text();
  assert.match(html, /INKLING AGENT HANDOFF<\/h1>/u);
  assert.match(html, /<title>Inkling<\/title>/u);
  assert.doesNotMatch(html, /inkling-initial-route/u);
});

test("only application pages are rendered", () => {
  const fetch = api({});
  assert.equal(render("/api/health", fetch), undefined);
  assert.equal(render("/assets/index.js", fetch), undefined);
  assert.equal(render("/public/documents/doc_0123456789", fetch), undefined);
});
