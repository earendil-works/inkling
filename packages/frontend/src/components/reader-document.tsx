import type { DocumentResponse } from "@earendil-works/jot-protocol";

import { formatDate } from "../ui.ts";
import { MarkdownArticle } from "./markdown-article.tsx";

export interface ReaderDocumentProps {
  readonly document: DocumentResponse;
}

export function ReaderDocument({ document }: ReaderDocumentProps): React.JSX.Element {
  const openComments = document.comments.threads.filter((thread) => !thread.resolved).length;

  return (
    <div className="reader-document" data-reader="">
      <header className="reader-heading">
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
      </header>
      <MarkdownArticle
        className="markdown-body reader-body"
        source={document.body}
        sourcePositions
      />
    </div>
  );
}
