import type { DocumentResponse } from "@earendil-works/jot-protocol";

import { useRenderedMarkdown } from "../markdown.tsx";
import { metadataWithFrontmatter } from "./document-metadata.ts";
import { DocumentPage } from "./document-page.tsx";
import { MarkdownArticle } from "./markdown-article.tsx";

export interface ReaderDocumentProps {
  readonly document: DocumentResponse;
}

export function ReaderDocument({ document }: ReaderDocumentProps): React.JSX.Element {
  const rendered = useRenderedMarkdown(document.body, true);
  if (document.metadata.publishedRevision === undefined) {
    return (
      <section className="empty-state reader-unpublished" data-reader="" data-unpublished="">
        <span>○</span>
        <h1>{document.metadata.title}</h1>
        <p>This document has not been published yet.</p>
      </section>
    );
  }
  const metadata = metadataWithFrontmatter(document.metadata, rendered.frontmatter, rendered.title);

  return (
    <div className="reader-document" data-reader="">
      <DocumentPage headings={rendered.headings} metadata={metadata}>
        <MarkdownArticle className="markdown-body reader-body" rendered={rendered} />
      </DocumentPage>
    </div>
  );
}
