import { Effect, Schema } from "effect";

import { wikiIndexLabel, wikiLabel } from "@earendil-works/inkling-core";
import type {
  CatalogResponse,
  DocumentSummary,
  ReferenceResolutionDto,
} from "@earendil-works/inkling-protocol";
import { outlineWiki, resolvedReferenceLabel } from "@earendil-works/inkling-renderer";
import type { WikiOutlineItem } from "@earendil-works/inkling-renderer";

import type { ApiClientService, ApiError } from "./api.ts";
import { WIKI_PATH, documentHref } from "./ui.ts";

/** An entry of the wiki's navigation: a page to read, or a section that folds. */
export interface WikiNavigationItem {
  readonly kind: "page" | "section";
  /** The page's reader path; sections have none. */
  readonly href?: string | undefined;
  readonly label: string;
  readonly items: readonly WikiNavigationItem[];
}

const WikiNavigationItemSchema: Schema.Schema<WikiNavigationItem> = Schema.Struct({
  href: Schema.optional(Schema.String),
  items: Schema.Array(Schema.suspend(() => WikiNavigationItemSchema)),
  kind: Schema.Literal("page", "section"),
  label: Schema.String,
});

/**
 * The wiki's navigation for one reader, laid out by the index note (the note
 * labelled `wiki-index`, read at `/wiki`): its `##` groups, the sections that
 * fold, and its pages, as far as the reader may open them. Notes labelled
 * `wiki` the index doesn't list gather under "Unsorted".
 */
export const WikiNavigationSchema = Schema.Struct({
  groups: Schema.Array(
    Schema.Struct({
      items: Schema.Array(WikiNavigationItemSchema),
      label: Schema.optional(Schema.String),
    }),
  ),
  indexId: Schema.String,
  title: Schema.String,
});
export type WikiNavigation = typeof WikiNavigationSchema.Type;

/** The wiki's index note: the newest note labelled `wiki-index` the reader can find. */
export function findWikiIndex(
  api: ApiClientService,
): Effect.Effect<DocumentSummary | undefined, ApiError> {
  return api
    .listDocuments(`label:${wikiIndexLabel}`)
    .pipe(
      Effect.map(
        (catalog) =>
          catalog.documents
            .filter((summary) => summary.metadata.labels.includes(wikiIndexLabel))
            .toSorted((a, b) => b.metadata.updatedAt.localeCompare(a.metadata.updatedAt))[0],
      ),
    );
}

/** How long the browser reuses the navigation while the reader moves between wiki pages. */
const navigationLifetimeMilliseconds = 30_000;
let browserNavigation:
  | { readonly expires: number; readonly navigation: WikiNavigation | undefined }
  | undefined;

/**
 * Builds the reader's wiki navigation from the published index, with the
 * reader's own access, so nobody sees a page they cannot open. Titles come from
 * the reader's catalog, which finds the index, the wiki's pages, and the RFCs at
 * once; only links to other documents are resolved one by one. The browser
 * reuses it for a while, so moving between wiki pages doesn't build it again;
 * the server never shares it between readers.
 */
export function loadWikiNavigation(
  api: ApiClientService,
): Effect.Effect<WikiNavigation | undefined, ApiError> {
  const remembers = typeof window !== "undefined";
  if (remembers && browserNavigation !== undefined && browserNavigation.expires > Date.now()) {
    return Effect.succeed(browserNavigation.navigation);
  }
  return Effect.all(
    [
      findWikiIndex(api),
      api.listDocuments(`label:${wikiLabel} is:published`),
      api.listDocuments("is:rfc"),
    ],
    { concurrency: "unbounded" },
  ).pipe(
    Effect.flatMap(([index, catalog, rfcs]) =>
      index === undefined
        ? Effect.succeed(undefined)
        : api
            .readDocument(index.metadata.id, true)
            .pipe(Effect.flatMap((document) => navigationFrom(api, document, catalog, rfcs))),
    ),
    Effect.tap((navigation) =>
      Effect.sync(() => {
        if (remembers) {
          browserNavigation = { expires: Date.now() + navigationLifetimeMilliseconds, navigation };
        }
      }),
    ),
  );
}

/** What the reader's catalogs say about the documents references name, by reference key. */
function catalogResolutions(
  catalogs: readonly CatalogResponse[],
): Readonly<Record<string, ReferenceResolutionDto>> {
  const resolutions: Record<string, ReferenceResolutionDto> = {};
  for (const { metadata } of catalogs.flatMap((catalog) => catalog.documents)) {
    const resolution: ReferenceResolutionDto = {
      href: documentHref(metadata.id, metadata.rfcNumber, false, "read", ""),
      status: "available",
      title: metadata.title,
      ...(metadata.rfcNumber === undefined ? {} : { rfcNumber: metadata.rfcNumber }),
    };
    resolutions[`doc:${metadata.id}`] = resolution;
    if (metadata.rfcNumber !== undefined) resolutions[`rfc:${metadata.rfcNumber}`] = resolution;
  }
  return resolutions;
}

function navigationFrom(
  api: ApiClientService,
  index: { readonly body: string; readonly metadata: { id: string; title: string } },
  catalog: CatalogResponse,
  rfcs: CatalogResponse,
): Effect.Effect<WikiNavigation, ApiError> {
  return outlineWiki(index.body).pipe(
    // An index that does not parse lays nothing out; its pages are still unsorted.
    Effect.orElseSucceed(() => []),
    Effect.flatMap((outline) => {
      const known = catalogResolutions([catalog, rfcs]);
      const unknown = [...new Set(outline.flatMap((group) => referenceKeys(group.items)))].filter(
        (key) => known[key] === undefined,
      );
      return (
        unknown.length === 0
          ? Effect.succeed({})
          : api.resolveReferences(unknown).pipe(Effect.map((response) => response.references))
      ).pipe(
        Effect.map((resolved) => {
          const resolutions = { ...resolved, ...known };
          const toItems = (items: readonly WikiOutlineItem[]): WikiNavigationItem[] =>
            items.flatMap((item): WikiNavigationItem[] => {
              const children = toItems(item.items);
              if (item.kind === "section") {
                return children.length === 0
                  ? []
                  : [{ items: children, kind: "section", label: item.label }];
              }
              const resolution = resolutions[item.reference.key];
              // A page the reader cannot open leaves its own pages to its parent.
              if (resolution?.status !== "available") return children;
              return [
                {
                  href: resolution.href,
                  items: children,
                  kind: "page",
                  label: item.label ?? resolvedReferenceLabel(item.reference, resolution),
                },
              ];
            });
          const groups = outline
            .map((group) => ({
              items: toItems(group.items),
              ...(group.label === undefined ? {} : { label: group.label }),
            }))
            .filter((group) => group.items.length > 0);

          const placed = new Set(groups.flatMap((group) => pageHrefs(group.items)));
          const unsorted = catalog.documents
            .filter(
              (summary) =>
                summary.metadata.id !== index.metadata.id &&
                summary.metadata.rfcNumber === undefined &&
                summary.metadata.labels.includes(wikiLabel) &&
                !placed.has(readerPath(summary)),
            )
            .toSorted((a, b) => a.metadata.title.localeCompare(b.metadata.title))
            .map((summary): WikiNavigationItem => ({
              href: readerPath(summary),
              items: [],
              kind: "page",
              label: summary.metadata.title,
            }));
          return {
            groups:
              unsorted.length === 0 ? groups : [...groups, { items: unsorted, label: "Unsorted" }],
            indexId: index.metadata.id,
            title: index.metadata.title,
          };
        }),
      );
    }),
  );
}

function referenceKeys(items: readonly WikiOutlineItem[]): string[] {
  return items.flatMap((item) => [
    ...(item.kind === "page" ? [item.reference.key] : []),
    ...referenceKeys(item.items),
  ]);
}

function pageHrefs(items: readonly WikiNavigationItem[]): string[] {
  return items.flatMap((item) => [
    ...(item.href === undefined ? [] : [item.href]),
    ...pageHrefs(item.items),
  ]);
}

function readerPath(summary: DocumentSummary): string {
  return documentHref(summary.metadata.id, summary.metadata.rfcNumber, false, "read", "");
}

/** Whether `items` lead to the page at `path`, at any depth. */
export function containsWikiPath(items: readonly WikiNavigationItem[], path: string): boolean {
  return items.some((item) => item.href === path || containsWikiPath(item.items, path));
}

/** The index is read at `/wiki`, so links to its own path mean the wiki's root. */
export function wikiReaderPath(
  document: {
    readonly id: string;
    readonly rfcNumber?: number | undefined;
  },
  wiki: WikiNavigation,
): string {
  return document.id === wiki.indexId
    ? WIKI_PATH
    : documentHref(document.id, document.rfcNumber, false, "read", "");
}
