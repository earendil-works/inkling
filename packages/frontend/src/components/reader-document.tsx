import type { DocumentResponse } from "@earendil-works/inkling-protocol";

import { useRenderedMarkdown } from "../markdown.tsx";
import { metadataWithFrontmatter } from "./document-metadata.ts";
import { DocumentPage } from "./document-page.tsx";
import emptyStateStyles from "./empty-state.module.css";
import markdownStyles from "./markdown-article.module.css";
import { MarkdownArticle } from "./markdown-article.tsx";
import styles from "./reader.module.css";

export interface ReaderDocumentProps {
  readonly document: DocumentResponse;
}

export function ReaderDocument({ document }: ReaderDocumentProps): React.JSX.Element {
  const rendered = useRenderedMarkdown(document.body, true);
  if (document.metadata.deletedAt !== undefined) {
    return (
      <section
        className={emptyStateStyles["root"]}
        data-empty-state=""
        data-reader=""
        data-trashed=""
      >
        <span>×</span>
        <p className={styles["trashedEyebrow"]}>In Trash</p>
        <h1>{document.metadata.title}</h1>
        <p>Open the editor to inspect or change this document before it is permanently deleted.</p>
      </section>
    );
  }
  if (document.metadata.publishedRevision === undefined) {
    return (
      <section
        className={emptyStateStyles["root"]}
        data-empty-state=""
        data-reader=""
        data-unpublished=""
      >
        <span>○</span>
        <h1>{document.metadata.title}</h1>
        <p>This document has not been published yet.</p>
      </section>
    );
  }
  const metadata = metadataWithFrontmatter(document.metadata, rendered.frontmatter, rendered.title);

  return (
    <div className={styles["document"]} data-reader="">
      <DocumentPage headings={rendered.headings} metadata={metadata}>
        <MarkdownArticle
          className={`${markdownStyles["body"]} ${markdownStyles["documentBody"]}`}
          rendered={rendered}
        />
      </DocumentPage>
    </div>
  );
}
