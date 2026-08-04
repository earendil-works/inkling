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
  readonly rewriteUrl?: (url: string) => string | undefined;
}

/** A deterministic renderer implemented once for previews and published artifacts. */
export interface MarkdownRenderer {
  render(markdown: string, options?: RenderOptions): RenderedMarkdown;
}
