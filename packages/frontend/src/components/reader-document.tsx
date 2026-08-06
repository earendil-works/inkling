import type { DocumentResponse } from "@earendil-works/jot-protocol";

import { useRenderedMarkdown } from "../markdown.tsx";
import { DocumentPage } from "./document-page.tsx";
import { MarkdownArticle } from "./markdown-article.tsx";

export interface ReaderDocumentProps {
  readonly document: DocumentResponse;
}

export function ReaderDocument({ document }: ReaderDocumentProps): React.JSX.Element {
  const rendered = useRenderedMarkdown(document.body, true);

  return (
    <div className="reader-document" data-reader="">
      <DocumentPage headings={rendered.headings} metadata={document.metadata}>
        <MarkdownArticle className="markdown-body reader-body" rendered={rendered} />
      </DocumentPage>
    </div>
  );
}
