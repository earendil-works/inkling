import { useEffect, useRef } from "react";
import { Fiber } from "effect";

import { Prose } from "@earendil-works/elanor-react";

import { browserRuntime } from "../effect-runtime.ts";
import { useHeadingLinkCopying } from "../heading-links.ts";
import { renderMermaid, useThemeRevision } from "../markdown.tsx";
import type { RenderedMarkdown } from "../markdown.tsx";
import styles from "./markdown-article.module.css";

export interface MarkdownArticleProps {
  /** The reader path that copied section links point to. */
  readonly documentPath: string;
  readonly rendered: RenderedMarkdown;
}

export function MarkdownArticle({
  documentPath,
  rendered,
}: MarkdownArticleProps): React.JSX.Element {
  const articleRef = useRef<HTMLElement>(null);
  const themeRevision = useThemeRevision();
  const copyHeadingLink = useHeadingLinkCopying(documentPath);

  useEffect(() => {
    const article = articleRef.current;
    if (article === null || rendered.html === "") return;
    const fiber = browserRuntime.runFork(renderMermaid(article));
    return () => {
      browserRuntime.runFork(Fiber.interrupt(fiber));
    };
  }, [rendered.html, themeRevision]);

  return (
    <Prose
      aria-busy={rendered.loading}
      className={styles["body"]}
      dangerouslySetInnerHTML={{ __html: rendered.html }}
      data-preview=""
      key={themeRevision}
      onClick={copyHeadingLink}
      ref={articleRef as React.Ref<HTMLDivElement>}
      render={<article />}
    />
  );
}
