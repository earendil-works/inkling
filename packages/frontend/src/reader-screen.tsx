import { useEffect } from "react";

import type { DocumentResponse } from "@earendil-works/jot-protocol";

import { useAppContext } from "./app-context.tsx";
import { MarkdownArticle } from "./markdown.tsx";
import { documentHref, formatDate } from "./ui.ts";

export interface ReaderScreenProps {
  readonly document: DocumentResponse;
  readonly shared: boolean;
}

export function ReaderScreen({ document, shared }: ReaderScreenProps): React.JSX.Element {
  const { setParticipants, setStatus } = useAppContext();
  const openComments = document.comments.threads.filter((thread) => !thread.resolved).length;
  const canEdit = !shared || document.metadata.sharing.access === "edit";

  useEffect(() => {
    setParticipants([]);
    setStatus({ label: "Document loaded", state: "ready" });
  }, [setParticipants, setStatus]);

  return (
    <main className="reader-layout" id="app" tabIndex={-1}>
      <nav className="document-bar reader-toolbar" aria-label="Document navigation">
        <div className="document-identity">
          <span>
            {document.metadata.rfcNumber === undefined
              ? "Document"
              : `RFC ${String(document.metadata.rfcNumber).padStart(4, "0")}`}
          </span>
          <strong className="reader-toolbar__title">{document.metadata.title}</strong>
        </div>
        <div className="document-actions">
          <a className="toolbar-button document-mode-link" href="/">
            All documents
          </a>
          {canEdit ? (
            <a
              className="primary-button primary-button--small document-mode-link"
              data-open-editor=""
              href={documentHref(document.metadata.id, shared, "edit")}
            >
              Edit
            </a>
          ) : null}
        </div>
      </nav>
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
    </main>
  );
}
