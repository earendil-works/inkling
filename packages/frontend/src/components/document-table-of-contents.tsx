import { useEffect, useRef, useState } from "react";

import type { RenderHeading } from "@earendil-works/inkling-renderer";

export interface DocumentTableOfContentsProps {
  readonly headings: readonly RenderHeading[];
}

export function DocumentTableOfContents({
  headings,
}: DocumentTableOfContentsProps): React.JSX.Element | null {
  const tableOfContentsRef = useRef<HTMLElement>(null);
  const [activeHeadingId, setActiveHeadingId] = useState<string>();
  useActiveHeading(headings, tableOfContentsRef, setActiveHeadingId);

  if (headings.length === 0) return null;
  const minimumDepth = Math.min(...headings.map((heading) => heading.depth));
  const currentHeadingId = headings.some((heading) => heading.id === activeHeadingId)
    ? activeHeadingId
    : headings[0]?.id;

  return (
    <nav
      aria-label="On this page"
      className="reader-toc"
      data-reader-toc=""
      ref={tableOfContentsRef}
    >
      <p>On this page</p>
      <ol>
        {headings.map((heading) => {
          const level = Math.min(3, heading.depth - minimumDepth + 1);
          const current = heading.id === currentHeadingId;
          return (
            <li
              className={`reader-toc__level-${level}`}
              data-current-heading={current ? "" : undefined}
              key={heading.id}
            >
              <a aria-current={current ? "location" : undefined} href={`#${heading.id}`}>
                {heading.text}
              </a>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function useActiveHeading(
  headings: readonly RenderHeading[],
  tableOfContentsRef: React.RefObject<HTMLElement | null>,
  setActiveHeadingId: React.Dispatch<React.SetStateAction<string | undefined>>,
): void {
  useEffect(() => {
    const tableOfContents = tableOfContentsRef.current;
    const documentPage = tableOfContents?.closest<HTMLElement>("[data-document-page]");
    if (tableOfContents === null || documentPage === null || documentPage === undefined) return;

    const scrollContainer = tableOfContents.closest<HTMLElement>(".editor-preview-page");
    const scrollTarget: HTMLElement | Window = scrollContainer ?? window;
    let frame: number | undefined;
    let headingElements: readonly HTMLElement[] = [];

    const collectHeadingElements = (): void => {
      const elementsById = new Map(
        [...documentPage.querySelectorAll<HTMLElement>("[id]")].map((element) => [
          element.id,
          element,
        ]),
      );
      headingElements = headings.flatMap((heading) => {
        const element = elementsById.get(heading.id);
        return element === undefined ? [] : [element];
      });
    };
    const updateActiveHeading = (): void => {
      frame = undefined;
      if (headingElements.length === 0) {
        setActiveHeadingId(headings[0]?.id);
        return;
      }
      const firstHeading = headingElements[0];
      const viewportTop = scrollContainer?.getBoundingClientRect().top ?? 0;
      const scrollMargin =
        firstHeading === undefined
          ? 0
          : Number.parseFloat(getComputedStyle(firstHeading).scrollMarginTop);
      const activationTop = viewportTop + (Number.isFinite(scrollMargin) ? scrollMargin : 0);
      let active = firstHeading;
      for (const heading of headingElements) {
        if (heading.getBoundingClientRect().top > activationTop + 1) break;
        active = heading;
      }

      const atBottom =
        scrollContainer === null
          ? window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 1
          : scrollContainer.scrollTop + scrollContainer.clientHeight >=
            scrollContainer.scrollHeight - 1;
      if (atBottom) active = headingElements.at(-1);
      setActiveHeadingId(active?.id);
    };
    const scheduleUpdate = (): void => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(updateActiveHeading);
    };

    collectHeadingElements();
    scheduleUpdate();
    scrollTarget.addEventListener("scroll", scheduleUpdate, { passive: true });
    window.addEventListener("resize", scheduleUpdate);
    window.addEventListener("hashchange", scheduleUpdate);
    const mutationObserver = new MutationObserver(() => {
      collectHeadingElements();
      scheduleUpdate();
    });
    mutationObserver.observe(documentPage, { childList: true, subtree: true });
    const resizeObserver = new ResizeObserver(scheduleUpdate);
    resizeObserver.observe(documentPage);

    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      scrollTarget.removeEventListener("scroll", scheduleUpdate);
      window.removeEventListener("resize", scheduleUpdate);
      window.removeEventListener("hashchange", scheduleUpdate);
      mutationObserver.disconnect();
      resizeObserver.disconnect();
    };
  }, [headings, setActiveHeadingId, tableOfContentsRef]);
}
