import { Schema } from "effect";

import {
  AuthenticationStatusSchema,
  CatalogResponseSchema,
  DocumentHeadingSchema,
  DocumentResponseSchema,
  PersonSchema,
  ReferenceResolutionSchema,
} from "@earendil-works/inkling-protocol";

import type { ApiClientService } from "./api.ts";

const AccountSchema = AuthenticationStatusSchema.fields.principal;

const RouteBaseFields = {
  account: AccountSchema,
  capabilityToken: Schema.optional(Schema.String),
};

const FrontmatterVocabularySchema = Schema.Struct({
  labels: Schema.Array(Schema.String),
  people: Schema.Array(PersonSchema),
  states: Schema.Array(Schema.String),
});

/**
 * Everything a route needs to render, without the API client. The server
 * loads it to render the page and embeds it so the browser hydrates without
 * fetching the same data again.
 */
export const RouteDataSchema = Schema.Union(
  Schema.Struct({
    ...RouteBaseFields,
    document: DocumentResponseSchema,
    frontmatterVocabulary: FrontmatterVocabularySchema,
    publicDocument: Schema.Boolean,
    /** Resolutions of the document's references for this reader. */
    references: Schema.Record({
      key: Schema.String,
      value: ReferenceResolutionSchema,
    }),
    screen: Schema.Literal("editor", "reader"),
    shared: Schema.Boolean,
  }),
  Schema.Struct({
    ...RouteBaseFields,
    catalog: CatalogResponseSchema,
    publicCatalog: Schema.Boolean,
    screen: Schema.Literal("labels"),
    selectedLabel: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    ...RouteBaseFields,
    catalog: CatalogResponseSchema,
    publicCatalog: Schema.Boolean,
    screen: Schema.Literal("workspace"),
  }),
  Schema.Struct({
    ...RouteBaseFields,
    catalog: CatalogResponseSchema,
    screen: Schema.Literal("trash"),
  }),
  Schema.Struct({
    ...RouteBaseFields,
    documentId: Schema.String,
    screen: Schema.Literal("share-password"),
  }),
);
export type RouteData = typeof RouteDataSchema.Type;

export type RouteModel = RouteData & { readonly api: ApiClientService };

const RenderedMarkdownSchema = Schema.Struct({
  frontmatter: Schema.optional(
    Schema.Struct({
      authors: Schema.optional(Schema.Array(Schema.String)),
      labels: Schema.optional(Schema.Array(Schema.String)),
      state: Schema.optional(Schema.String),
      visibility: Schema.optional(Schema.Literal("public", "private", "confidential")),
    }),
  ),
  headings: Schema.Array(DocumentHeadingSchema),
  html: Schema.String,
  key: Schema.String,
  /** Reference destinations in source order. */
  references: Schema.Array(Schema.String),
  title: Schema.optional(Schema.String),
});
export type PrerenderedMarkdown = typeof RenderedMarkdownSchema.Type;

/** The route a server-rendered page was rendered from, embedded for hydration. */
export const InitialRouteSchema = Schema.Struct({
  href: Schema.String,
  markdown: Schema.Array(RenderedMarkdownSchema),
  route: RouteDataSchema,
});
export type InitialRoute = typeof InitialRouteSchema.Type;

export const initialRouteElementId = "inkling-initial-route";
