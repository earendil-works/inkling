import type { DocumentResponse } from "@earendil-works/jot-protocol";

import { useRenderedMarkdown } from "../markdown.tsx";
import { formatDate } from "../ui.ts";
import { DocumentTableOfContents } from "./document-table-of-contents.tsx";
import { MarkdownArticle } from "./markdown-article.tsx";

export interface ReaderDocumentProps {
  readonly document: DocumentResponse;
}

export function ReaderDocument({ document }: ReaderDocumentProps): React.JSX.Element {
  const rendered = useRenderedMarkdown(document.body, true);
  const openComments = document.comments.threads.filter((thread) => !thread.resolved).length;
  const folio =
    document.metadata.rfcNumber === undefined
      ? "Note"
      : `RFC ${String(document.metadata.rfcNumber).padStart(4, "0")}`;

  return (
    <div className="reader-document" data-reader="">
      <header className="reader-heading">
        <p className="reader-folio">{folio}</p>
        <div className="reader-heading__main">
          <p className="eyebrow">
            {document.metadata.lifecycleState} · {document.metadata.visibility}
          </p>
          <h1>{document.metadata.title}</h1>
          <div className="reader-meta">
            <span>Updated {formatDate(document.metadata.updatedAt)}</span>
            <span>
              {openComments} open {openComments === 1 ? "comment" : "comments"}
            </span>
            {document.metadata.sensitivity === "confidential" ? (
              <strong className="reader-confidential">Confidential</strong>
            ) : null}
            {document.metadata.labels.map((label) => (
              <span className="reader-label" key={label}>
                {label}
              </span>
            ))}
          </div>
        </div>
      </header>
      <div className="reader-content-grid">
        <MarkdownArticle className="markdown-body reader-body" rendered={rendered} />
        <DocumentTableOfContents headings={rendered.headings} />
      </div>
    </div>
  );
}
