import { EditIcon } from "@earendil-works/elanor-icons-react";
import { Heading, Separator } from "@earendil-works/elanor-react";
import type { DocumentResponse } from "@earendil-works/inkling-protocol";

import type { ApiClientService } from "../api.ts";
import { useDocumentMarkdown } from "../markdown.tsx";
import type { ReferenceResolutionRecord } from "../markdown.tsx";
import { documentHref, formatDate } from "../ui.ts";
import { ButtonLink } from "./button-link.tsx";
import { metadataWithFrontmatter } from "./document-metadata.ts";
import { useMediaQuery } from "./document-page.tsx";
import { DocumentTableOfContents } from "./document-table-of-contents.tsx";
import { MarkdownArticle } from "./markdown-article.tsx";
import { ReaderDocument } from "./reader-document.tsx";
import styles from "./wiki-document.module.css";

/*
 * A wiki page as documentation reads, like Elanor's and pi.dev's docs: its
 * title, when it last changed and a link to edit it, then its content with the
 * page's sections beside it. The document's other metadata (state, audience,
 * authors) stays in Inkling's own reader and editor.
 */

export interface WikiDocumentProps {
  readonly api?: ApiClientService | undefined;
  readonly document: DocumentResponse;
  readonly references?: ReferenceResolutionRecord | undefined;
  /** Whether the reader may edit it. */
  readonly editable: boolean;
}

export function WikiDocument({
  api,
  document,
  references,
  editable,
}: WikiDocumentProps): React.JSX.Element {
  const rendered = useDocumentMarkdown(api, document.body, document.metadata, references);
  const wide = useMediaQuery("(width > 68rem)", true);
  // A trashed or unpublished page explains itself as Inkling's reader does.
  if (
    document.metadata.deletedAt !== undefined ||
    document.metadata.publishedRevision === undefined
  ) {
    return <ReaderDocument api={api} document={document} references={references} />;
  }
  const metadata = metadataWithFrontmatter(document.metadata, rendered.frontmatter, rendered.title);
  const tableOfContents = (
    <DocumentTableOfContents headings={rendered.headings} presentation={wide ? "list" : "menu"} />
  );
  return (
    <div className={styles["page"]} data-reader="" data-wiki-document="">
      <header className={styles["header"]}>
        <Heading className={styles["title"]} level={1} size={1}>
          {metadata.title}
        </Heading>
        <div className={styles["metadata"]}>
          <span className={styles["updated"]}>
            Last updated <time dateTime={metadata.updatedAt}>{formatDate(metadata.updatedAt)}</time>
          </span>
          {editable ? (
            <ButtonLink
              className={styles["edit"]}
              data-open-editor=""
              density="compact"
              hierarchy="tertiary"
              href={documentHref(metadata.id, metadata.rfcNumber, false, "edit", "")}
              iconStart={<EditIcon />}
            >
              Edit
            </ButtonLink>
          ) : null}
        </div>
      </header>
      {/* On narrow screens, the sections' menu has its own borders. */}
      {wide || rendered.headings.length === 0 ? <Separator /> : tableOfContents}
      <div className={styles["content"]}>
        <MarkdownArticle
          documentPath={documentHref(metadata.id, metadata.rfcNumber, false, "read", "")}
          rendered={rendered}
        />
        {wide ? tableOfContents : null}
      </div>
    </div>
  );
}
