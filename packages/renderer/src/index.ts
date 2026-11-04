import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { classHighlighter, highlightCode } from "@lezer/highlight";
import { Context, Data, Effect, Layer } from "effect";
import MarkdownIt from "markdown-it";
import type { MarkdownIt as MarkdownItType, Token } from "markdown-it";
import YAML from "yaml";

import {
  parseReference,
  pendingReferenceLabel,
  referenceTargetPath,
  referenceTitle,
  resolvedReferenceLabel,
  rewriteLegacyRfcUrl,
  sectionLabel,
  unavailableReferenceLabel,
} from "./references.ts";
import type { DocumentReference, ReferenceResolutions } from "./references.ts";

export * from "./references.ts";

const inklingCodeLanguages = languages;
export const inklingSyntaxHighlighter = classHighlighter;

export interface RenderHeading {
  readonly depth: number;
  readonly id: string;
  /** The section number, such as `3.2`; only RFC headings are numbered. */
  readonly number?: string | undefined;
  readonly text: string;
}

export interface DocumentFrontmatter {
  readonly authors?: readonly string[] | undefined;
  readonly labels?: readonly string[] | undefined;
  readonly state?: string | undefined;
  readonly visibility?: "public" | "private" | "confidential" | undefined;
}

export interface ParsedDocumentSource {
  readonly body: string;
  readonly bodyOffset: number;
  readonly frontmatter: DocumentFrontmatter | undefined;
}

export interface ProtectedLink {
  readonly destination: string;
  readonly index: number;
  readonly source: string;
}

export interface RenderedMarkdown {
  readonly frontmatter: DocumentFrontmatter | undefined;
  readonly html: string;
  readonly headings: readonly RenderHeading[];
  readonly protectedLinks: readonly ProtectedLink[];
  /** Links to other documents, in source order. */
  readonly references: readonly DocumentReference[];
  readonly title: string | undefined;
}

export interface DocumentOutline {
  readonly headings: readonly RenderHeading[];
  readonly title: string | undefined;
}

export interface RenderOptions {
  /** Number section headings, as RFCs do. */
  readonly numberHeadings?: boolean | undefined;
  readonly protectedLinkHref?: ((link: ProtectedLink) => string) | undefined;
  /** Resolved reference targets by reference key; missing keys render as pending. */
  readonly references?: ReferenceResolutions | undefined;
  /** Where a reference the reader cannot open leads, such as a sign-in redirect. */
  readonly unavailableReferenceHref?: ((reference: DocumentReference) => string) | undefined;
  readonly rewriteUrl?: ((url: string) => string | undefined) | undefined;
  /** Add Markdown source ranges to rendered block elements for interactive previews. */
  readonly sourcePositions?: boolean | undefined;
}

export class RenderError extends Data.TaggedError("RenderError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface MarkdownRendererService {
  readonly render: (
    markdown: string,
    options?: RenderOptions,
  ) => Effect.Effect<RenderedMarkdown, RenderError>;
}

export const MarkdownRenderer = Context.GenericTag<MarkdownRendererService>(
  "@earendil-works/inkling/MarkdownRenderer",
);

export const MarkdownRendererLive = Layer.succeed(MarkdownRenderer, makeMarkdownRenderer());

/** A deterministic renderer used by previews and published artifacts. */
export function makeMarkdownRenderer(): MarkdownRendererService {
  return {
    render: (markdown, options = {}) =>
      markdown.length > 5_000_000
        ? Effect.fail(new RenderError({ message: "Markdown exceeds the 5 MB render limit." }))
        : parseDocumentSource(markdown).pipe(
            Effect.flatMap((source) =>
              Effect.tryPromise({
                catch: (cause) =>
                  new RenderError({
                    cause,
                    message:
                      cause instanceof ProtectedLinkError
                        ? cause.message
                        : "Markdown rendering failed.",
                  }),
                try: () => renderMarkdown(source, options),
              }),
            ),
          ),
  };
}

export function parseDocumentSource(
  markdown: string,
): Effect.Effect<ParsedDocumentSource, RenderError> {
  return Effect.try({
    catch: (cause) =>
      new RenderError({
        cause,
        message: cause instanceof Error ? cause.message : "Document frontmatter is invalid.",
      }),
    try: () => parseDocumentSourceUnsafe(markdown),
  });
}

export function serializeDocumentFrontmatter(frontmatter: {
  readonly authors: readonly string[];
  readonly labels: readonly string[];
  readonly state: string;
  readonly visibility: "public" | "private" | "confidential";
}): string {
  const yaml = YAML.stringify(
    {
      authors: [...frontmatter.authors],
      state: frontmatter.state,
      visibility: frontmatter.visibility,
      labels: [...frontmatter.labels],
    },
    { lineWidth: 0 },
  ).trimEnd();
  return `---\n${yaml}\n---\n`;
}

async function renderMarkdown(
  source: ParsedDocumentSource,
  options: RenderOptions,
): Promise<RenderedMarkdown> {
  const { body: markdown, bodyOffset, frontmatter } = source;
  const headings: RenderHeading[] = [];
  const protectedLinks: ProtectedLink[] = [];
  const references: DocumentReference[] = [];
  const lineOffsets = sourceLineOffsets(markdown);
  const parser = createParser();

  parser.core.ruler.after("inline", "inkling-links-tasks-and-source-positions", (state) => {
    headings.push(...annotateHeadings(state.tokens, options.numberHeadings === true));
    const sections = new Map(headings.map((heading) => [heading.id, heading]));
    for (const token of state.tokens) {
      rewriteTokenUrls(token, parser, options, protectedLinks);
      if (options.sourcePositions === true) {
        annotateSourcePosition(token, lineOffsets, markdown.length, bodyOffset);
      }
      if (token.type === "inline" && token.children !== null) {
        rewriteReferences(token.children, state.Token, options, sections, references);
        for (const child of token.children) {
          rewriteTokenUrls(child, parser, options, protectedLinks);
        }
        rewriteTaskList(token.children, parser);
      }
    }
  });

  parser.renderer.rules["heading_open"] = (tokens, index) => {
    const token = tokens[index];
    if (token === undefined) return "";
    const heading = token.meta as HeadingMeta | null;
    const id = heading?.id === undefined ? "" : ` id="${parser.utils.escapeHtml(heading.id)}"`;
    const number =
      heading?.number === undefined
        ? ""
        : `<span class="inkling-section-number">${parser.utils.escapeHtml(heading.number)}</span> `;
    return `<${token.tag}${id}${parser.renderer.renderAttrs(token)}>${number}`;
  };

  parser.renderer.rules["heading_close"] = (tokens, index) => {
    const token = tokens[index];
    if (token === undefined) return "";
    const heading = tokens[index - 2]?.meta as HeadingMeta | null | undefined;
    const anchor =
      heading?.id === undefined
        ? ""
        : ` <a class="inkling-heading-anchor" href="#${parser.utils.escapeHtml(encodeURIComponent(heading.id))}" aria-label="Link to this section">#</a>`;
    return `${anchor}</${token.tag}>\n`;
  };

  parser.renderer.rules["fence"] = (tokens, index) => {
    const token = tokens[index];
    if (token === undefined) {
      return "";
    }
    const language = token.info.trim().split(/\s+/u)[0]?.toLocaleLowerCase("en") ?? "";
    const code = token.content;
    const sourceAttributes = parser.renderer.renderAttrs(token);
    if (language === "mermaid") {
      if (code.length > 100_000) {
        return `<pre class="inkling-code inkling-code--rejected"${sourceAttributes}><code>Mermaid diagram exceeds the 100 KB render limit.</code></pre>\n`;
      }
      return `<div class="inkling-mermaid" data-mermaid${sourceAttributes}><pre><code>${parser.utils.escapeHtml(code)}</code></pre><div class="inkling-mermaid__controls"><button type="button" data-mermaid-zoom-in aria-label="Zoom in">+</button><button type="button" data-mermaid-zoom-out aria-label="Zoom out">−</button><button type="button" data-mermaid-reset>Reset</button></div></div>\n`;
    }
    const description = findInklingCodeLanguage(token.info);
    const highlighted =
      description?.support === undefined
        ? parser.utils.escapeHtml(code)
        : highlightCodeAsHtml(code, description.support.language.parser, parser.utils.escapeHtml);
    const classes = [
      description?.support === undefined ? undefined : "inkling-syntax",
      language ? `language-${language}` : undefined,
    ]
      .filter((value): value is string => value !== undefined)
      .map((value) => parser.utils.escapeHtml(value));
    const className = classes.length === 0 ? "" : ` class="${classes.join(" ")}"`;
    return `<pre class="inkling-code"${sourceAttributes}><code${className}>${highlighted}</code></pre>\n`;
  };

  const environment = {};
  const tokens = parser.parse(markdown, environment);
  const titleIndex = tokens.findIndex(
    (token) => token.type === "heading_open" && token.tag === "h1",
  );
  const title = titleIndex === -1 ? undefined : inlineTokenText(tokens[titleIndex + 1]);
  const contentTokens =
    titleIndex === -1 ? tokens : [...tokens.slice(0, titleIndex), ...tokens.slice(titleIndex + 3)];
  const languagesToLoad = new Set<LanguageDescription>();
  for (const token of contentTokens) {
    if (token.type !== "fence") continue;
    const description = findInklingCodeLanguage(token.info);
    if (description !== null) languagesToLoad.add(description);
  }
  await Promise.all(
    [...languagesToLoad].map((description) => description.load().catch(() => undefined)),
  );
  return {
    frontmatter,
    headings,
    html: parser.renderer.render(contentTokens, parser.options, environment),
    protectedLinks,
    references,
    title,
  };
}

function createParser(): MarkdownItType {
  return new MarkdownIt({
    breaks: true,
    html: false,
    linkify: true,
    typographer: false,
  });
}

/**
 * The title and (numbered) section headings of a document, exactly as
 * rendering identifies them, without rendering it.
 */
export function outlineDocument(
  markdown: string,
  options: { readonly numberHeadings?: boolean | undefined } = {},
): Effect.Effect<DocumentOutline, RenderError> {
  return parseDocumentSource(markdown).pipe(
    Effect.flatMap((source) =>
      Effect.try({
        catch: (cause) => new RenderError({ cause, message: "Markdown rendering failed." }),
        try: () => {
          const tokens = createParser().parse(source.body, {});
          const headings = annotateHeadings(tokens, options.numberHeadings === true);
          const titleIndex = tokens.findIndex(
            (token) => token.type === "heading_open" && token.tag === "h1",
          );
          const title = titleIndex === -1 ? undefined : inlineTokenText(tokens[titleIndex + 1]);
          return { headings, title };
        },
      }),
    ),
  );
}

/** The references a document makes, in the order rendering reports them. */
export function collectReferences(
  markdown: string,
): Effect.Effect<readonly DocumentReference[], RenderError> {
  return parseDocumentSource(markdown).pipe(
    Effect.flatMap((source) =>
      Effect.try({
        catch: (cause) => new RenderError({ cause, message: "Markdown rendering failed." }),
        try: () => {
          const references: DocumentReference[] = [];
          for (const token of createParser().parse(source.body, {})) {
            if (token.type !== "inline" || token.children === null) continue;
            for (const child of token.children) {
              if (child.type !== "link_open") continue;
              const reference = documentReferenceOf(child, references.length);
              if (reference !== undefined) references.push(reference);
            }
          }
          return references;
        },
      }),
    ),
  );
}

interface HeadingMeta {
  readonly id: string;
  readonly number?: string | undefined;
}

/**
 * Gives every section heading its ID and, when numbering, its section
 * number. The title, the first top-level heading, is not a section. A
 * heading may pin its ID with a trailing `{#id}`, so renaming it keeps links.
 */
function annotateHeadings(tokens: readonly Token[], numbered: boolean): RenderHeading[] {
  const headings: RenderHeading[] = [];
  const usedIds = new Map<string, number>();
  const titleIndex = tokens.findIndex(
    (token) => token.type === "heading_open" && token.tag === "h1",
  );
  const sectionDepths: number[] = [];
  const sectionPath: number[] = [];
  const childCounts = new Map<string, number>();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const inline = tokens[index + 1];
    if (token?.type !== "heading_open" || index === titleIndex || inline === undefined) continue;
    const depth = Number(token.tag.slice(1));
    const pinned = takePinnedHeadingId(inline);
    const text = inlineTokenText(inline) ?? inline.content;
    const base = pinned ?? slugify(text);
    const count = usedIds.get(base) ?? 0;
    usedIds.set(base, count + 1);
    const id = count === 0 ? base : `${base}-${count + 1}`;
    let number: string | undefined;
    if (numbered) {
      // A heading nests under the closest preceding shallower heading, so
      // skipped levels do not leave empty components in its number.
      while ((sectionDepths.at(-1) ?? 0) >= depth) {
        sectionDepths.pop();
        sectionPath.pop();
      }
      const parent = sectionPath.join(".");
      const position = (childCounts.get(parent) ?? 0) + 1;
      childCounts.set(parent, position);
      sectionDepths.push(depth);
      sectionPath.push(position);
      number = sectionPath.join(".");
    }
    token.meta = { id, number } satisfies HeadingMeta;
    headings.push(number === undefined ? { depth, id, text } : { depth, id, number, text });
  }
  return headings;
}

function inlineTokenText(token: Token | undefined): string | undefined {
  if (token?.type !== "inline") return undefined;
  const text = (token.children ?? [])
    .map((child) =>
      child.type === "softbreak" || child.type === "hardbreak" ? " " : child.content,
    )
    .join("")
    .replace(/\s+/gu, " ")
    .trim();
  return text === "" ? undefined : text.slice(0, 300);
}

function parseDocumentSourceUnsafe(markdown: string): ParsedDocumentSource {
  if (!markdown.startsWith("---\n")) {
    return { body: markdown, bodyOffset: 0, frontmatter: undefined };
  }
  const match = /^---\n([\s\S]*?)\n---[\t ]*(?:\n|$)/u.exec(markdown);
  if (match === null) {
    throw new Error("Document frontmatter is not terminated.");
  }
  const parsed = YAML.parse(match[1] ?? "") as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Document frontmatter must be a YAML mapping.");
  }
  const values = parsed as Readonly<Record<string, unknown>>;
  const authors = optionalAuthors(values["authors"]);
  const state = optionalNonEmptyString(values["state"], "state");
  const legacyVisibility = optionalEnum(values["visibility"], "visibility", [
    "public",
    "private",
    "confidential",
    "workspace",
    "internal",
  ]);
  const legacySensitivity = optionalEnum(values["sensitivity"], "sensitivity", [
    "confidential",
    "normal",
  ]);
  const visibility =
    legacySensitivity === "confidential" || legacyVisibility === "confidential"
      ? "confidential"
      : legacyVisibility === "public"
        ? "public"
        : legacyVisibility === undefined
          ? undefined
          : "private";
  const labels = optionalLabels(values["labels"]);
  return {
    body: markdown.slice(match[0].length),
    bodyOffset: match[0].length,
    frontmatter: { authors, labels, state, visibility },
  };
}

function optionalNonEmptyString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Frontmatter ${label} must be a non-empty string.`);
  }
  return value.trim();
}

function optionalEnum<const Value extends string>(
  value: unknown,
  label: string,
  allowed: readonly Value[],
): Value | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !allowed.includes(value as Value)) {
    throw new Error(`Frontmatter ${label} must be one of: ${allowed.join(", ")}.`);
  }
  return value as Value;
}

function optionalAuthors(value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((author) => typeof author !== "string")) {
    throw new Error("Frontmatter authors must be a list of email addresses.");
  }
  const authors = [
    ...new Set(
      value.map((author) => String(author).trim().toLocaleLowerCase("en")).filter(Boolean),
    ),
  ];
  if (
    authors.length > 100 ||
    authors.some((author) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(author) || author.length > 320)
  ) {
    throw new Error("Frontmatter authors must contain valid email addresses.");
  }
  return authors;
}

function optionalLabels(value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((label) => typeof label !== "string")) {
    throw new Error("Frontmatter labels must be a list of strings.");
  }
  return value.map((label) => String(label).trim()).filter(Boolean);
}

export function findInklingCodeLanguage(info: string): LanguageDescription | null {
  const language = info.trim().split(/\s+/u)[0]?.toLocaleLowerCase("en") ?? "";
  return language === "" || language === "mermaid"
    ? null
    : LanguageDescription.matchLanguageName(inklingCodeLanguages, language, true);
}

function highlightCodeAsHtml(
  source: string,
  parser: { readonly parse: (source: string) => Parameters<typeof highlightCode>[1] },
  escapeHtml: (value: string) => string,
): string {
  let html = "";
  highlightCode(
    source,
    parser.parse(source),
    inklingSyntaxHighlighter,
    (text, classes) => {
      const escapedText = escapeHtml(text);
      html +=
        classes === "" ? escapedText : `<span class="${escapeHtml(classes)}">${escapedText}</span>`;
    },
    () => {
      html += "\n";
    },
  );
  return html;
}

const sourcePositionTokenTypes = new Set([
  "blockquote_open",
  "bullet_list_open",
  "code_block",
  "fence",
  "heading_open",
  "list_item_open",
  "ordered_list_open",
  "paragraph_open",
  "table_open",
  "tr_open",
]);

function sourceLineOffsets(markdown: string): readonly number[] {
  const offsets = [0];
  for (let index = 0; index < markdown.length; index += 1) {
    if (markdown[index] === "\n") offsets.push(index + 1);
  }
  return offsets;
}

function annotateSourcePosition(
  token: Token,
  lineOffsets: readonly number[],
  markdownLength: number,
  bodyOffset: number,
): void {
  if (!sourcePositionTokenTypes.has(token.type) || token.map === null) return;
  const start = (lineOffsets[token.map[0]] ?? markdownLength) + bodyOffset;
  const end = (lineOffsets[token.map[1]] ?? markdownLength) + bodyOffset;
  token.attrSet("data-inkling-source-start", String(start));
  token.attrSet("data-inkling-source-end", String(end));
  token.attrSet("data-inkling-source-kind", token.type.replace(/_(?:open|block)$/u, ""));
}

function rewriteTokenUrls(
  token: Token,
  parser: MarkdownItType,
  options: RenderOptions,
  protectedLinks: ProtectedLink[],
): void {
  const attribute =
    token.type === "image" ? "src" : token.type === "link_open" ? "href" : undefined;
  if (attribute === undefined) return;
  if ((token.meta as { readonly inklingReference?: boolean } | null)?.inklingReference === true) {
    return;
  }
  const original = token.attrGet(attribute);
  if (original === null) return;

  const originalUrl = String(original);
  const protectedDestination = parseProtectedLinkDestination(originalUrl);
  if (token.type === "image" && protectedDestination !== undefined) {
    throw new ProtectedLinkError(
      "The __require_auth parameter can only protect links, not embedded images.",
    );
  }
  const destination = protectedDestination ?? originalUrl;
  const legacy = protectedDestination === undefined ? rewriteLegacyRfcUrl(destination) : undefined;
  const rewritten = options.rewriteUrl?.(legacy ?? destination) ?? legacy ?? destination;
  if (!parser.validateLink(rewritten)) {
    if (protectedDestination !== undefined) {
      throw new ProtectedLinkError("The protected link destination is not a safe URL.");
    }
    token.attrSet(attribute, "#unsafe-link");
    return;
  }
  if (protectedDestination !== undefined && !isExternalUrl(rewritten)) {
    throw new ProtectedLinkError(
      "The __require_auth parameter can only protect external HTTP or HTTPS links.",
    );
  }

  const protectedLink =
    protectedDestination === undefined
      ? undefined
      : ({
          destination: rewritten,
          index: protectedLinks.length,
          source: originalUrl,
        } satisfies ProtectedLink);
  if (protectedLink !== undefined) protectedLinks.push(protectedLink);
  token.attrSet(
    attribute,
    protectedLink === undefined
      ? rewritten
      : (options.protectedLinkHref?.(protectedLink) ?? protectedLink.destination),
  );
  if (token.type === "link_open" && isExternalUrl(rewritten)) {
    token.attrSet("rel", "noopener noreferrer");
    token.attrSet("target", "_blank");
  }
}

class ProtectedLinkError extends Error {}

const protectedLinkParameter = "__require_auth";

function parseProtectedLinkDestination(value: string): string | undefined {
  const hashIndex = value.indexOf("#");
  const beforeHash = hashIndex === -1 ? value : value.slice(0, hashIndex);
  const fragment = hashIndex === -1 ? "" : value.slice(hashIndex);
  const queryIndex = beforeHash.indexOf("?");
  if (queryIndex === -1) return undefined;

  const prefix = beforeHash.slice(0, queryIndex);
  const components = beforeHash.slice(queryIndex + 1).split("&");
  const markers = components.flatMap((component, index) => {
    const separator = component.indexOf("=");
    const rawName = separator === -1 ? component : component.slice(0, separator);
    const rawValue = separator === -1 ? "" : component.slice(separator + 1);
    return decodeQueryComponent(rawName) === protectedLinkParameter
      ? [{ index, value: decodeQueryComponent(rawValue) }]
      : [];
  });
  if (markers.length === 0) return undefined;
  if (markers.length !== 1 || markers[0]?.value !== "1") {
    throw new ProtectedLinkError(
      "The __require_auth parameter must occur exactly once with the value 1.",
    );
  }
  if (!isExternalUrl(value)) {
    throw new ProtectedLinkError(
      "The __require_auth parameter can only protect external HTTP or HTTPS links.",
    );
  }

  const markerIndex = markers[0]?.index;
  const retained = components.filter((_component, index) => index !== markerIndex);
  return `${prefix}${retained.length === 0 ? "" : `?${retained.join("&")}`}${fragment}`;
}

function decodeQueryComponent(value: string): string {
  try {
    return decodeURIComponent(value.replaceAll("+", " "));
  } catch {
    return value;
  }
}

const pinnedHeadingIdPattern = /[\t ]+\{#([\p{Letter}\p{Number}_-]{1,200})\}[\t ]*$/u;

/** Removes a trailing `{#id}` from a heading and returns the pinned ID. */
function takePinnedHeadingId(inline: Token): string | undefined {
  const last = inline.children?.at(-1);
  if (last?.type !== "text") return undefined;
  const match = pinnedHeadingIdPattern.exec(last.content);
  if (match?.[1] === undefined) return undefined;
  last.content = last.content.slice(0, match.index);
  inline.content = inline.content.replace(pinnedHeadingIdPattern, "");
  return match[1];
}

type TokenConstructor = new (type: string, tag: string, nesting: -1 | 0 | 1) => Token;

function documentReferenceOf(token: Token, index: number): DocumentReference | undefined {
  const source = token.attrGet("href");
  if (source === null) return undefined;
  const reference = parseReference(String(source));
  return reference === undefined ? undefined : { ...reference, index, source: String(source) };
}

/**
 * Points references at their targets and fills in the label of automatic
 * references: autolinks such as `<rfc:57#motivation>` and links without
 * text, including `[](#motivation)` within the same document. Links with
 * their own text keep it and show the resolved target on hover.
 */
function rewriteReferences(
  children: Token[],
  TokenClass: TokenConstructor,
  options: RenderOptions,
  sections: ReadonlyMap<string, RenderHeading>,
  references: DocumentReference[],
): void {
  for (let index = 0; index < children.length; index += 1) {
    const token = children[index];
    if (token?.type !== "link_open") continue;
    const href = String(token.attrGet("href") ?? "");
    const automatic = token.markup === "autolink" || children[index + 1]?.type === "link_close";
    const label = (text: string): void => {
      if (!automatic) return;
      const next = children[index + 1];
      if (token.markup === "autolink" && next?.type === "text") {
        next.content = text;
        return;
      }
      const content = new TokenClass("text", "", 0);
      content.content = text;
      children.splice(index + 1, 0, content);
    };

    if (href.startsWith("#") && href.length > 1) {
      if (!automatic) continue;
      const id = safeDecode(href.slice(1));
      const section = sections.get(id);
      token.attrJoin("class", "inkling-reference");
      token.attrSet("data-reference-status", section === undefined ? "missing" : "available");
      label(section === undefined ? `${href} (missing section)` : sectionLabel(section, true));
      continue;
    }

    const reference = documentReferenceOf(token, references.length);
    if (reference === undefined) continue;
    references.push(reference);
    const resolution = options.references?.get(reference.key);
    const fragment =
      reference.anchor === undefined ? "" : `#${encodeURIComponent(reference.anchor)}`;
    token.meta = { ...(token.meta as object | null), inklingReference: true };
    token.attrJoin("class", "inkling-reference");
    if (resolution === undefined) {
      token.attrSet("href", `${referenceTargetPath(reference.target)}${fragment}`);
      token.attrSet("data-reference-status", "pending");
      label(pendingReferenceLabel(reference));
    } else if (resolution.status === "unavailable") {
      token.attrSet(
        "href",
        options.unavailableReferenceHref?.(reference) ??
          `${referenceTargetPath(reference.target)}${fragment}`,
      );
      token.attrSet("data-reference-status", "unavailable");
      label(unavailableReferenceLabel(reference.target));
    } else {
      const missing = reference.anchor !== undefined && resolution.section === undefined;
      // Resolutions only ever lead to reader paths on this site.
      const path = /^\/[^/\\]/u.test(resolution.href)
        ? resolution.href
        : referenceTargetPath(reference.target);
      token.attrSet("href", `${path}${fragment}`);
      token.attrSet("data-reference-status", missing ? "missing" : "available");
      const full = resolvedReferenceLabel(reference, resolution);
      if (automatic) {
        if (reference.anchor !== undefined) token.attrSet("title", referenceTitle(resolution));
        label(full);
      } else {
        token.attrSet("title", full);
      }
    }
  }
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function rewriteTaskList(tokens: Token[], parser: MarkdownItType): void {
  const first = tokens[0];
  if (first?.type !== "text") {
    return;
  }
  const match = /^\[([ xX])\]\s+/u.exec(first.content);
  if (match === null) {
    return;
  }
  const checked = match[1]?.toLocaleLowerCase("en") === "x";
  const remaining = parser.utils.escapeHtml(first.content.slice(match[0].length));
  first.type = "html_inline";
  first.content = `<input class="task-list-item-checkbox" type="checkbox" disabled${checked ? " checked" : ""}> ${remaining}`;
}

function slugify(value: string): string {
  const slug = value
    .normalize("NFKD")
    .toLocaleLowerCase("en")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-|-$/gu, "");
  return slug.length === 0 ? "section" : slug;
}

function isExternalUrl(value: string): boolean {
  return /^https?:\/\/[^/?#\s]+(?:[/?#]|$)/iu.test(value);
}
