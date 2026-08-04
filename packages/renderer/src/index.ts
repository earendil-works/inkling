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
      Effect.try({
        catch: (cause) => new RenderError({ cause, message: "Markdown rendering failed." }),
        try: () => renderMarkdown(markdown, options),
      }),
  };
}

function renderMarkdown(markdown: string, options: RenderOptions): RenderedMarkdown {
  const headings: RenderHeading[] = [];
  const usedHeadingIds = new Map<string, number>();
  const parser = new MarkdownIt({
    breaks: true,
    html: false,
    linkify: true,
    typographer: false,
  });

  parser.core.ruler.after("inline", "jot-links-and-tasks", (state) => {
    for (const token of state.tokens) {
      rewriteTokenUrls(token, parser, options);
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
    return `<${token.tag} id="${parser.utils.escapeHtml(id)}">`;
  };

  parser.renderer.rules["fence"] = (tokens, index) => {
    const token = tokens[index];
    if (token === undefined) {
      return "";
    }
    const language = token.info.trim().split(/\s+/u)[0]?.toLocaleLowerCase("en") ?? "";
    const source = token.content;
    if (language === "mermaid") {
      return `<div class="jot-mermaid" data-mermaid><pre><code>${parser.utils.escapeHtml(source)}</code></pre><div class="jot-mermaid__controls"><button type="button" data-mermaid-zoom-in aria-label="Zoom in">+</button><button type="button" data-mermaid-zoom-out aria-label="Zoom out">−</button><button type="button" data-mermaid-reset>Reset</button></div></div>\n`;
    }
    const highlighted =
      language.length > 0 && hljs.getLanguage(language) !== undefined
        ? hljs.highlight(source, { language }).value
        : parser.utils.escapeHtml(source);
    const className =
      language.length === 0 ? "" : ` class="language-${parser.utils.escapeHtml(language)}"`;
    return `<pre class="jot-code"><code${className}>${highlighted}</code></pre>\n`;
  };

  return { headings, html: parser.render(markdown) };
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
