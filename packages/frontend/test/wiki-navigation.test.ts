import assert from "node:assert/strict";
import test from "node:test";

import { Effect, Either } from "effect";

import { makeApiClient } from "../src/api.ts";
import { loadRoute } from "../src/route-loader.ts";
import type { RouteEnvironment } from "../src/route-loader.ts";
import { loadWikiNavigation } from "../src/wiki-navigation.ts";

function metadata(
  id: string,
  title: string,
  labels: readonly string[],
  extra: Readonly<Record<string, unknown>> = {},
) {
  return {
    approvers: [],
    authors: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    headRevision: 2,
    id,
    labels,
    lifecycleState: "published",
    publishedRevision: 2,
    relatedDocuments: [],
    reviewers: [],
    sharing: { access: "disabled", generation: 0 },
    title,
    updatedAt: "2026-01-01T00:00:00.000Z",
    visibility: "private",
    ...extra,
  };
}

const index = metadata("doc_index00000", "Earendil Wiki", ["wiki-index"]);
const indexBody = `# Earendil Wiki

- [](doc:doc_wifi000000)

## Company

- [](doc:doc_howwework0)
- [Time off](doc:doc_holidays00)
- [](doc:doc_secret0000)

## Engineering

### Decisions

- <rfc:12>
`;

const wikiNotes = [
  metadata("doc_wifi000000", "Office Wi-Fi", ["wiki"]),
  metadata("doc_howwework0", "How we work", ["wiki"]),
  metadata("doc_holidays00", "Holidays", ["wiki"]),
  metadata("doc_parking000", "Parking", ["wiki"]),
  metadata("doc_zebra00000", "Zebra crossings", ["wiki"]),
];

/** Inkling's answers for a reader who may open everything but `doc_secret0000`. */
const responses: Readonly<Record<string, unknown>> = {
  "/api/auth/status": {
    authenticated: true,
    principal: { displayName: "Ada", id: "ada", role: "member" },
  },
  [`/api/documents?q=${encodeURIComponent("label:wiki-index")}`]: {
    documents: [{ excerpt: "", metadata: index }],
  },
  [`/api/documents?q=${encodeURIComponent("label:wiki is:published")}`]: {
    documents: [...wikiNotes, index].map((entry) => ({ excerpt: "", metadata: entry })),
  },
  "/api/documents/doc_index00000?published=true": {
    body: indexBody,
    comments: { revision: 0, threads: [] },
    metadata: index,
    sequence: 2,
  },
};

function resolution(key: string): unknown {
  const titles: Readonly<Record<string, string>> = {
    "doc:doc_holidays00": "Holidays",
    "doc:doc_howwework0": "How we work",
    "doc:doc_wifi000000": "Office Wi-Fi",
  };
  if (key === "rfc:12") {
    return { href: "/rfc/0012", rfcNumber: 12, status: "available", title: "One wiki" };
  }
  const title = titles[key];
  return title === undefined
    ? { status: "unavailable" }
    : { href: `/documents/${key.slice("doc:".length)}`, status: "available", title };
}

function environment(): RouteEnvironment {
  return {
    api: (capabilityToken) =>
      makeApiClient(capabilityToken, (path) => {
        if (path.startsWith("/api/references?")) {
          const keys = new URLSearchParams(path.slice(path.indexOf("?"))).getAll("ref");
          return Promise.resolve(
            Response.json({
              references: Object.fromEntries(keys.map((key) => [key, resolution(key)])),
            }),
          );
        }
        const response = responses[path];
        return Promise.resolve(
          response === undefined
            ? Response.json(
                { code: "not_found", message: `Missing ${path}.`, retryable: false },
                { status: 404 },
              )
            : Response.json(response),
        );
      }),
    preloadDocumentScreen: () => Promise.resolve(),
  };
}

test("the wiki's navigation lays out the index for the reader and gathers the rest", async () => {
  const navigation = await Effect.runPromise(loadWikiNavigation(environment().api(undefined)));
  assert.deepEqual(navigation, {
    groups: [
      {
        items: [
          { href: "/documents/doc_wifi000000", items: [], kind: "page", label: "Office Wi-Fi" },
        ],
      },
      {
        // The secret page the reader cannot open is left out; own link text wins.
        items: [
          { href: "/documents/doc_howwework0", items: [], kind: "page", label: "How we work" },
          { href: "/documents/doc_holidays00", items: [], kind: "page", label: "Time off" },
        ],
        label: "Company",
      },
      {
        items: [
          {
            items: [{ href: "/rfc/0012", items: [], kind: "page", label: "RFC 0012: One wiki" }],
            kind: "section",
            label: "Decisions",
          },
        ],
        label: "Engineering",
      },
      {
        // Wiki notes the index doesn't list, by title; never the index itself.
        items: [
          { href: "/documents/doc_parking000", items: [], kind: "page", label: "Parking" },
          { href: "/documents/doc_zebra00000", items: [], kind: "page", label: "Zebra crossings" },
        ],
        label: "Unsorted",
      },
    ],
    indexId: "doc_index00000",
    title: "Earendil Wiki",
  });
});

test("/wiki reads the index with the wiki's navigation", async () => {
  const loaded = await Effect.runPromise(
    Effect.either(loadRoute(new URL("https://inkling.test/wiki"), environment())),
  );
  assert.ok(Either.isRight(loaded));
  const model = loaded.right;
  assert.equal(model.screen, "reader");
  assert.ok(model.screen === "reader");
  assert.equal(model.document.metadata.id, "doc_index00000");
  assert.equal(model.wiki?.groups.length, 4);
});

test("/wiki explains a missing index to signed-in readers", async () => {
  const withoutIndex: RouteEnvironment = {
    ...environment(),
    api: (capabilityToken) =>
      makeApiClient(capabilityToken, (path) =>
        path === `/api/documents?q=${encodeURIComponent("label:wiki-index")}`
          ? Promise.resolve(Response.json({ documents: [] }))
          : Promise.resolve(Response.json(responses[path] ?? {})),
      ),
  };
  const loaded = await Effect.runPromise(
    Effect.either(loadRoute(new URL("https://inkling.test/wiki"), withoutIndex)),
  );
  assert.ok(Either.isLeft(loaded));
  assert.equal(loaded.left.code, "not_found");
  assert.match(loaded.left.message, /label a note “wiki-index”/u);
});
