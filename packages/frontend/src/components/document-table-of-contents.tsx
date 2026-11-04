import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { TableOfContents } from "@earendil-works/elanor-react";
import type { RenderHeading } from "@earendil-works/inkling-renderer";

import styles from "./reader.module.css";

export interface DocumentTableOfContentsProps {
  readonly headings: readonly RenderHeading[];
  /** `list` sits beside the document; `menu` collapses into a sticky bar above it. */
  readonly presentation: "list" | "menu";
}

interface HeadingNode {
  readonly children: HeadingNode[];
  readonly heading: RenderHeading;
}

export function DocumentTableOfContents({
  headings,
  presentation,
}: DocumentTableOfContentsProps): React.JSX.Element | null {
  const tableOfContentsRef = useRef<HTMLElement>(null);
  const [activeHeadingId, setActiveHeadingId] = useState<string>();
  useActiveHeading(headings, tableOfContentsRef, setActiveHeadingId, presentation);

  if (headings.length === 0) return null;
  const currentHeading = headings.find((heading) => heading.id === activeHeadingId) ?? headings[0];
  const list = <HeadingList currentId={currentHeading?.id} nodes={headingTree(headings)} />;

  if (presentation === "menu") {
    return (
      <TableOfContents.Menu
        data-reader-toc=""
        ref={tableOfContentsRef as React.Ref<HTMLDivElement>}
      >
        <TableOfContents.MenuTrigger label="On this page">
          {currentHeading === undefined ? undefined : headingLabel(currentHeading)}
        </TableOfContents.MenuTrigger>
        <TableOfContents.MenuPopup label="On this page">{list}</TableOfContents.MenuPopup>
      </TableOfContents.Menu>
    );
  }

  return (
    <TableOfContents.Root
      aria-label="On this page"
      className={styles["toc"]}
      data-reader-toc=""
      ref={tableOfContentsRef}
    >
      <p className={styles["tocTitle"]}>On this page</p>
      {list}
      <TableOfContents.Indicator />
    </TableOfContents.Root>
  );
}

function HeadingList({
  currentId,
  nodes,
}: {
  readonly currentId: string | undefined;
  readonly nodes: readonly HeadingNode[];
}): ReactNode {
  return (
    <TableOfContents.List>
      {nodes.map(({ children, heading }) => (
        <TableOfContents.Item key={heading.id}>
          <TableOfContents.Link
            active={heading.id === currentId}
            href={`#${encodeURIComponent(heading.id)}`}
          >
            {headingLabel(heading)}
          </TableOfContents.Link>
          {children.length === 0 ? null : <HeadingList currentId={currentId} nodes={children} />}
        </TableOfContents.Item>
      ))}
    </TableOfContents.List>
  );
}

/** RFC sections lead with their number. */
function headingLabel(heading: RenderHeading): string {
  return heading.number === undefined ? heading.text : `${heading.number} ${heading.text}`;
}

/** Nests headings by depth, at most three levels deep, relative to the shallowest heading. */
function headingTree(headings: readonly RenderHeading[]): readonly HeadingNode[] {
  const minimumDepth = Math.min(...headings.map((heading) => heading.depth));
  const roots: HeadingNode[] = [];
  const ancestors: { readonly level: number; readonly node: HeadingNode }[] = [];
  for (const heading of headings) {
    const level = Math.min(3, heading.depth - minimumDepth + 1);
    const node: HeadingNode = { children: [], heading };
    while ((ancestors.at(-1)?.level ?? 0) >= level) ancestors.pop();
    const parent = ancestors.at(-1);
    if (parent === undefined) roots.push(node);
    else parent.node.children.push(node);
    ancestors.push({ level, node });
  }
  return roots;
}

/** A computed length in pixels; `auto` and other non-lengths count as zero. */
function cssPixels(value: string): number {
  const pixels = Number.parseFloat(value);
  return Number.isFinite(pixels) ? pixels : 0;
}

function useActiveHeading(
  headings: readonly RenderHeading[],
  tableOfContentsRef: React.RefObject<HTMLElement | null>,
  setActiveHeadingId: React.Dispatch<React.SetStateAction<string | undefined>>,
  presentation: DocumentTableOfContentsProps["presentation"],
): void {
  useEffect(() => {
    const tableOfContents = tableOfContentsRef.current;
    const documentPage = tableOfContents?.closest<HTMLElement>("[data-document-page]");
    if (tableOfContents === null || documentPage === null || documentPage === undefined) return;

    const scrollContainer = tableOfContents.closest<HTMLElement>("[data-preview-scroller]");
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
      // A heading counts as reached where jumping to it places it: below the scroller's scroll
      // padding and the heading's own scroll margin.
      const scrollPadding = cssPixels(
        getComputedStyle(scrollContainer ?? document.documentElement).scrollPaddingTop,
      );
      const scrollMargin =
        firstHeading === undefined ? 0 : cssPixels(getComputedStyle(firstHeading).scrollMarginTop);
      const activationTop = viewportTop + scrollPadding + scrollMargin;
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
  }, [headings, presentation, setActiveHeadingId, tableOfContentsRef]);
}
