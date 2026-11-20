import { useEffect, useState } from "react";
import { Effect } from "effect";

import { CheckIcon, ContentCopyIcon, EditIcon } from "@earendil-works/elanor-icons-react";
import { Button, Grid, Heading, Separator } from "@earendil-works/elanor-react";
import type { DocumentResponse } from "@earendil-works/inkling-protocol";

import type { ApiClientService } from "../api.ts";
import { copyText } from "../clipboard.ts";
import { useDocumentMarkdown } from "../markdown.tsx";
import type { ReferenceResolutionRecord } from "../markdown.tsx";
import { documentHref, formatDate } from "../ui.ts";
import { ButtonLink } from "./button-link.tsx";
import { metadataWithFrontmatter } from "./document-metadata.ts";
import { DocumentTableOfContents } from "./document-table-of-contents.tsx";
import { MarkdownArticle } from "./markdown-article.tsx";
import { ReaderDocument } from "./reader-document.tsx";
import styles from "./wiki-document.module.css";

/*
 * A wiki page as Elanor's and pi.dev's docs show a page, on Elanor's 12-column
 * grid: the article (its title, when it last changed, buttons that copy its
 * Markdown and edit it, then its content) on nine columns, and its sections on
 * the other three from the wide layout; narrower, the sections are a menu
 * above the content. The document's other metadata (state, audience, authors)
 * stays in Inkling's own reader and editor.
 */

export interface WikiDocumentProps {
  readonly api?: ApiClientService | undefined;
  readonly document: DocumentResponse;
  readonly references?: ReferenceResolutionRecord | undefined;
  /** Whether the reader may edit it. */
  readonly editable: boolean;
}

/** The Markdown a reader copies: the source without its frontmatter. */
function pageMarkdown(source: string): string {
  return source.replace(/^---\n[\s\S]*?\n---[\t ]*(?:\n|$)/u, "").trim();
}

export function WikiDocument({
  api,
  document,
  references,
  editable,
}: WikiDocumentProps): React.JSX.Element {
  const rendered = useDocumentMarkdown(api, document.body, document.metadata, references);
  const [copied, setCopied] = useState<"copied" | "error" | "idle">("idle");
  useEffect(() => {
    if (copied !== "copied") return;
    const timer = setTimeout(() => setCopied("idle"), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  // A trashed or unpublished page explains itself as Inkling's reader does.
  if (
    document.metadata.deletedAt !== undefined ||
    document.metadata.publishedRevision === undefined
  ) {
    return <ReaderDocument api={api} document={document} references={references} />;
  }
  const metadata = metadataWithFrontmatter(document.metadata, rendered.frontmatter, rendered.title);
  const sections = rendered.headings.length > 0;

  return (
    <Grid.Root
      className={styles["grid"]}
      data-document-page=""
      data-reader=""
      data-wiki-document=""
    >
      <article className={styles["article"]} data-toc={sections ? "" : undefined}>
        <header className={styles["header"]}>
          <Heading level={1} size={1}>
            {metadata.title}
          </Heading>
          <div className={styles["metadata"]}>
            <span className={styles["updated"]}>
              Last updated{" "}
              <time dateTime={metadata.updatedAt}>{formatDate(metadata.updatedAt)}</time>
            </span>
            <Separator className={styles["metadataSeparator"]} orientation="vertical" />
            <Button
              className={styles["action"]}
              data-copy-page={copied}
              hierarchy="tertiary"
              iconStart={copied === "copied" ? <CheckIcon /> : <ContentCopyIcon />}
              onClick={() =>
                Effect.runPromise(copyText(pageMarkdown(document.body))).then(
                  () => setCopied("copied"),
                  () => setCopied("error"),
                )
              }
              title="Copy this page as Markdown"
            >
              {copied === "error" ? "Couldn’t copy" : "Copy page"}
            </Button>
            {editable ? (
              <ButtonLink
                className={styles["action"]}
                data-open-editor=""
                hierarchy="tertiary"
                href={documentHref(metadata.id, metadata.rfcNumber, false, "edit", "")}
                iconStart={<EditIcon />}
                title="Edit this page in Inkling"
              >
                Edit
              </ButtonLink>
            ) : null}
            <span className={styles["status"]} role="status">
              {copied === "copied" ? "Page copied as Markdown." : ""}
            </span>
          </div>
        </header>
        <Separator className={styles["pageSeparator"]} />
        {sections ? (
          <DocumentTableOfContents
            className={styles["tocMenu"]}
            headings={rendered.headings}
            presentation="menu"
          />
        ) : null}
        <MarkdownArticle
          documentPath={documentHref(metadata.id, metadata.rfcNumber, false, "read", "")}
          rendered={rendered}
        />
      </article>
      {sections ? (
        <div className={styles["tocColumn"]}>
          <DocumentTableOfContents
            className={styles["toc"]}
            headings={rendered.headings}
            presentation="list"
            titled={false}
          />
        </div>
      ) : null}
    </Grid.Root>
  );
}
