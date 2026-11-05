import { DeleteIcon, DescriptionIcon } from "@earendil-works/elanor-icons-react";
import type { DocumentResponse } from "@earendil-works/inkling-protocol";

import type { ApiClientService } from "../api.ts";
import { useDocumentMarkdown } from "../markdown.tsx";
import type { ReferenceResolutionRecord } from "../markdown.tsx";
import { documentHref } from "../ui.ts";
import { metadataWithFrontmatter } from "./document-metadata.ts";
import { DocumentPage } from "./document-page.tsx";
import { EmptyMessage } from "./empty-message.tsx";
import { MarkdownArticle } from "./markdown-article.tsx";
import styles from "./reader.module.css";

export interface ReaderDocumentProps {
  readonly api?: ApiClientService | undefined;
  readonly document: DocumentResponse;
  readonly references?: ReferenceResolutionRecord | undefined;
}

export function ReaderDocument({
  api,
  document,
  references,
}: ReaderDocumentProps): React.JSX.Element {
  const rendered = useDocumentMarkdown(api, document.body, document.metadata, references);
  if (document.metadata.deletedAt !== undefined) {
    return (
      <EmptyMessage
        data-reader=""
        data-trashed=""
        description="Open the editor to inspect or change this document before it is permanently deleted."
        icon={DeleteIcon}
        level={1}
        title={document.metadata.title}
        warning="In Trash"
      />
    );
  }
  // Personal documents are never published; their reader shows the working draft.
  if (
    document.metadata.publishedRevision === undefined &&
    document.metadata.personalOwner === undefined
  ) {
    return (
      <EmptyMessage
        data-reader=""
        data-unpublished=""
        description="This document has not been published yet."
        icon={DescriptionIcon}
        level={1}
        title={document.metadata.title}
      />
    );
  }
  const metadata = metadataWithFrontmatter(document.metadata, rendered.frontmatter, rendered.title);

  return (
    <div className={styles["document"]} data-reader="">
      <DocumentPage headings={rendered.headings} metadata={metadata}>
        <MarkdownArticle
          documentPath={documentHref(
            document.metadata.id,
            document.metadata.rfcNumber,
            false,
            "read",
            "",
          )}
          rendered={rendered}
        />
      </DocumentPage>
    </div>
  );
}
