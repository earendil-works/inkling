import { useEffect, useRef } from "react";
import { Fiber } from "effect";

import { browserRuntime } from "../effect-runtime.ts";
import { renderMermaid, useThemeRevision } from "../markdown.tsx";
import type { RenderedMarkdown } from "../markdown.tsx";

export interface MarkdownArticleProps {
  readonly className?: string | undefined;
  readonly rendered: RenderedMarkdown;
}

export function MarkdownArticle({ className, rendered }: MarkdownArticleProps): React.JSX.Element {
  const articleRef = useRef<HTMLElement>(null);
  const themeRevision = useThemeRevision();

  useEffect(() => {
    const article = articleRef.current;
    if (article === null || rendered.html === "") return;
    const fiber = browserRuntime.runFork(renderMermaid(article));
    return () => {
      browserRuntime.runFork(Fiber.interrupt(fiber));
    };
  }, [rendered.html, themeRevision]);

  return (
    <article
      aria-busy={rendered.loading}
      className={className}
      data-preview=""
      key={themeRevision}
      ref={articleRef}
      dangerouslySetInnerHTML={{ __html: rendered.html }}
    />
  );
}
