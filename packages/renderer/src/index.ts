import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { classHighlighter, highlightCode } from "@lezer/highlight";
import { Context, Data, Effect, Layer } from "effect";
import MarkdownIt from "markdown-it";
import type { MarkdownIt as MarkdownItType, Token } from "markdown-it";
import YAML from "yaml";

const inklingCodeLanguages = languages;
export const inklingSyntaxHighlighter = classHighlighter;

export interface RenderHeading {
  readonly depth: number;
  readonly id: string;
  readonly text: string;
}

export interface DocumentFrontmatter {
  readonly authors?: readonly string[] | undefined;
  readonly labels?: readonly string[] | undefined;
  readonly sensitivity?: "confidential" | "normal" | undefined;
  readonly state?: string | undefined;
  readonly visibility?: "public" | "workspace" | undefined;
}

export interface ParsedDocumentSource {
  readonly body: string;
  readonly bodyOffset: number;
  readonly frontmatter: DocumentFrontmatter | undefined;
}

export interface RenderedMarkdown {
  readonly frontmatter: DocumentFrontmatter | undefined;
  readonly html: string;
  readonly headings: readonly RenderHeading[];
  readonly title: string | undefined;
}

export interface RenderOptions {
  readonly rewriteUrl?: ((url: string) => string | undefined) | undefined;
  readonly gateExternalLinks?: boolean | undefined;
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
                catch: (cause) => new RenderError({ cause, message: "Markdown rendering failed." }),
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
  readonly sensitivity: "confidential" | "normal";
  readonly state: string;
  readonly visibility: "public" | "workspace";
}): string {
  const yaml = YAML.stringify(
    {
      authors: [...frontmatter.authors],
      state: frontmatter.state,
      visibility: frontmatter.visibility,
      sensitivity: frontmatter.sensitivity,
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
  const usedHeadingIds = new Map<string, number>();
  const lineOffsets = sourceLineOffsets(markdown);
  const parser = new MarkdownIt({
    breaks: true,
    html: false,
    linkify: true,
    typographer: false,
  });

  parser.core.ruler.after("inline", "inkling-links-tasks-and-source-positions", (state) => {
    for (const token of state.tokens) {
      rewriteTokenUrls(token, parser, options);
      if (options.sourcePositions === true) {
        annotateSourcePosition(token, lineOffsets, markdown.length, bodyOffset);
      }
      if (token.type === "inline" && token.children !== null) {
        for (const child of token.children) {
          rewriteTokenUrls(child, parser, options);
        }
        rewriteTaskList(token.children, parser);
      }
    }
  });

  parser.renderer.rules["heading_open"] = (tokens, index) => {
    const token = tokens[index];
    const inline = tokens[index + 1];
    if (token === undefined || inline === undefined) {
      return "";
    }
    const depth = Number(token.tag.slice(1));
    const text = inline.content;
    const base = slugify(text);
    const count = usedHeadingIds.get(base) ?? 0;
    usedHeadingIds.set(base, count + 1);
    const id = count === 0 ? base : `${base}-${count + 1}`;
    headings.push({ depth, id, text });
    return `<${token.tag} id="${parser.utils.escapeHtml(id)}"${parser.renderer.renderAttrs(token)}>`;
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
    title,
  };
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
  const visibility = optionalEnum(values["visibility"], "visibility", ["public", "workspace"]);
  const sensitivity = optionalEnum(values["sensitivity"], "sensitivity", [
    "confidential",
    "normal",
  ]);
  const labels = optionalLabels(values["labels"]);
  return {
    body: markdown.slice(match[0].length),
    bodyOffset: match[0].length,
    frontmatter: { authors, labels, sensitivity, state, visibility },
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

function rewriteTokenUrls(token: Token, parser: MarkdownItType, options: RenderOptions): void {
  const attribute =
    token.type === "image" ? "src" : token.type === "link_open" ? "href" : undefined;
  if (attribute === undefined) {
    return;
  }
  const original = token.attrGet(attribute);
  if (original === null) {
    return;
  }
  const originalUrl = String(original);
  const rewritten = options.rewriteUrl?.(originalUrl) ?? originalUrl;
  if (!parser.validateLink(rewritten)) {
    token.attrSet(attribute, "#unsafe-link");
    return;
  }
  const safeUrl =
    options.gateExternalLinks === true && isExternalUrl(rewritten)
      ? `/api/redirect?url=${encodeURIComponent(rewritten)}`
      : rewritten;
  token.attrSet(attribute, safeUrl);
  if (token.type === "link_open" && isExternalUrl(rewritten)) {
    token.attrSet("rel", "noopener noreferrer");
    token.attrSet("target", "_blank");
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
  return /^https?:\/\//iu.test(value);
}
