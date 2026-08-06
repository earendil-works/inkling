import type { DocumentResponse } from "@earendil-works/jot-protocol";

import { useRenderedMarkdown } from "../markdown.tsx";
import { DocumentPage, metadataWithFrontmatter } from "./document-page.tsx";
import { MarkdownArticle } from "./markdown-article.tsx";

export interface ReaderDocumentProps {
  readonly document: DocumentResponse;
}

export function ReaderDocument({ document }: ReaderDocumentProps): React.JSX.Element {
  const rendered = useRenderedMarkdown(document.body, true);
  const metadata = metadataWithFrontmatter(document.metadata, rendered.frontmatter);

  return (
    <div className="reader-document" data-reader="">
      <DocumentPage headings={rendered.headings} metadata={metadata}>
        <MarkdownArticle className="markdown-body reader-body" rendered={rendered} />
      </DocumentPage>
    </div>
  );
}
