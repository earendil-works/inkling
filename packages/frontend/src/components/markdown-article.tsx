import { useEffect, useRef } from "react";
import { Fiber } from "effect";

import { browserRuntime } from "../effect-runtime.ts";
import { renderMermaid, useRenderedMarkdown } from "../markdown.tsx";

export interface MarkdownArticleProps {
  readonly className?: string | undefined;
  readonly source: string;
  readonly sourcePositions?: boolean | undefined;
}

export function MarkdownArticle({
  className,
  source,
  sourcePositions = false,
}: MarkdownArticleProps): React.JSX.Element {
  const articleRef = useRef<HTMLElement>(null);
  const rendered = useRenderedMarkdown(source, sourcePositions);

  useEffect(() => {
    const article = articleRef.current;
    if (article === null || rendered.html === "") return;
    const fiber = browserRuntime.runFork(renderMermaid(article));
    return () => {
      browserRuntime.runFork(Fiber.interrupt(fiber));
    };
  }, [rendered.html]);

  return (
    <article
      aria-busy={rendered.loading}
      className={className}
      data-preview=""
      ref={articleRef}
      dangerouslySetInnerHTML={{ __html: rendered.html }}
    />
  );
}
