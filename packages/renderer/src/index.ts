import { Context, Data, Effect, Layer } from "effect";
import hljs from "highlight.js";
import MarkdownIt from "markdown-it";
import type { MarkdownIt as MarkdownItType, Token } from "markdown-it";

export interface RenderHeading {
  readonly depth: number;
  readonly id: string;
  readonly text: string;
}

export interface RenderedMarkdown {
  readonly html: string;
  readonly headings: readonly RenderHeading[];
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
  "@earendil-works/jot/MarkdownRenderer",
);

export const MarkdownRendererLive = Layer.succeed(MarkdownRenderer, makeMarkdownRenderer());

/** A deterministic renderer used by previews and published artifacts. */
export function makeMarkdownRenderer(): MarkdownRendererService {
  return {
    render: (markdown, options = {}) =>
      markdown.length > 5_000_000
        ? Effect.fail(new RenderError({ message: "Markdown exceeds the 5 MB render limit." }))
        : Effect.try({
            catch: (cause) => new RenderError({ cause, message: "Markdown rendering failed." }),
            try: () => renderMarkdown(markdown, options),
          }),
  };
}

function renderMarkdown(markdown: string, options: RenderOptions): RenderedMarkdown {
  const headings: RenderHeading[] = [];
  const usedHeadingIds = new Map<string, number>();
  const lineOffsets = sourceLineOffsets(markdown);
  const parser = new MarkdownIt({
    breaks: true,
    html: false,
    linkify: true,
    typographer: false,
  });

  parser.core.ruler.after("inline", "jot-links-tasks-and-source-positions", (state) => {
    for (const token of state.tokens) {
      rewriteTokenUrls(token, parser, options);
      if (options.sourcePositions === true) {
        annotateSourcePosition(token, lineOffsets, markdown.length);
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
    const source = token.content;
    const sourceAttributes = parser.renderer.renderAttrs(token);
    if (language === "mermaid") {
      if (source.length > 100_000) {
        return `<pre class="jot-code jot-code--rejected"${sourceAttributes}><code>Mermaid diagram exceeds the 100 KB render limit.</code></pre>\n`;
      }
      return `<div class="jot-mermaid" data-mermaid${sourceAttributes}><pre><code>${parser.utils.escapeHtml(source)}</code></pre><div class="jot-mermaid__controls"><button type="button" data-mermaid-zoom-in aria-label="Zoom in">+</button><button type="button" data-mermaid-zoom-out aria-label="Zoom out">−</button><button type="button" data-mermaid-reset>Reset</button></div></div>\n`;
    }
    const canHighlight = language.length > 0 && hljs.getLanguage(language) !== undefined;
    const highlighted = canHighlight
      ? hljs.highlight(source, { language }).value
      : parser.utils.escapeHtml(source);
    const classes = [
      canHighlight ? "hljs" : undefined,
      language ? `language-${language}` : undefined,
    ]
      .filter((value): value is string => value !== undefined)
      .map((value) => parser.utils.escapeHtml(value));
    const className = classes.length === 0 ? "" : ` class="${classes.join(" ")}"`;
    return `<pre class="jot-code"${sourceAttributes}><code${className}>${highlighted}</code></pre>\n`;
  };

  return { headings, html: parser.render(markdown) };
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
): void {
  if (!sourcePositionTokenTypes.has(token.type) || token.map === null) return;
  const start = lineOffsets[token.map[0]] ?? markdownLength;
  const end = lineOffsets[token.map[1]] ?? markdownLength;
  token.attrSet("data-jot-source-start", String(start));
  token.attrSet("data-jot-source-end", String(end));
  token.attrSet("data-jot-source-kind", token.type.replace(/_(?:open|block)$/u, ""));
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
