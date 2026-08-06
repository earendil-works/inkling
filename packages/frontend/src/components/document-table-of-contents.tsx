import type { RenderHeading } from "@earendil-works/jot-renderer";

export interface DocumentTableOfContentsProps {
  readonly headings: readonly RenderHeading[];
}

export function DocumentTableOfContents({
  headings,
}: DocumentTableOfContentsProps): React.JSX.Element | null {
  if (headings.length === 0) return null;
  const minimumDepth = Math.min(...headings.map((heading) => heading.depth));

  return (
    <nav aria-label="On this page" className="reader-toc" data-reader-toc="">
      <p>On this page</p>
      <ol>
        {headings.map((heading) => {
          const level = Math.min(3, heading.depth - minimumDepth + 1);
          return (
            <li className={`reader-toc__level-${level}`} key={heading.id}>
              <a href={`#${heading.id}`}>{heading.text}</a>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
