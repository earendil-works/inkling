import { useCallback, useSyncExternalStore } from "react";
import type { ReactNode } from "react";

import { Heading, KeyValue } from "@earendil-works/elanor-react";
import type { DocumentMetadataDto } from "@earendil-works/inkling-protocol";
import type { RenderHeading } from "@earendil-works/inkling-renderer";

import { documentFolio, formatDate } from "../ui.ts";
import { DocumentTableOfContents } from "./document-table-of-contents.tsx";
import { AudienceChip, Chip, LifecycleStateChip } from "./chip.tsx";
import styles from "./reader.module.css";

export interface DocumentPageProps {
  readonly children: ReactNode;
  readonly headings: readonly RenderHeading[];
  readonly metadata: DocumentMetadataDto;
  readonly presentation?: "preview" | "reader" | undefined;
}

export function DocumentPage({
  children,
  headings,
  metadata,
  presentation = "reader",
}: DocumentPageProps): React.JSX.Element {
  const wide = useMediaQuery("(width > 68rem)", true);
  const tableOfContents = (
    <DocumentTableOfContents
      headings={headings}
      presentation={presentation === "reader" && wide ? "list" : "menu"}
    />
  );

  return (
    <div
      className={`${styles["page"]}${presentation === "preview" ? ` ${styles["preview"]}` : ""}`}
      data-document-page=""
    >
      <header className={styles["heading"]}>
        <p className={styles["folio"]}>{documentFolio(metadata.rfcNumber)}</p>
        <div className={styles["headingMain"]}>
          <div className={styles["badges"]}>
            <LifecycleStateChip
              href={`/?q=${encodeURIComponent(`state:${metadata.lifecycleState}`)}`}
              state={metadata.lifecycleState}
            />
            <AudienceChip linked metadata={metadata} />
          </div>
          <Heading className={styles["title"]} level={1} size={presentation === "preview" ? 2 : 1}>
            {metadata.title}
          </Heading>
          {metadata.labels.length === 0 ? null : (
            <div aria-label="Labels" className={styles["labels"]}>
              {metadata.labels.map((label) => (
                <Chip href={`/labels?label=${encodeURIComponent(label)}`} key={label}>
                  {label}
                </Chip>
              ))}
            </div>
          )}
        </div>
      </header>
      <DocumentMetadata metadata={metadata} />
      {presentation === "reader" && wide ? null : tableOfContents}
      <div className={styles["contentGrid"]}>
        {children}
        {presentation === "reader" && wide ? tableOfContents : null}
      </div>
    </div>
  );
}

function DocumentMetadata({
  metadata,
}: {
  readonly metadata: DocumentMetadataDto;
}): React.JSX.Element {
  return (
    <KeyValue.Grid className={styles["metadata"]} data-document-metadata="">
      {metadata.personalOwner === undefined ? null : (
        <>
          <KeyValue.Key>Owner</KeyValue.Key>
          <KeyValue.Value data-document-owner="">
            <PeopleList people={[personalOwner(metadata)]} />
          </KeyValue.Value>
        </>
      )}
      {metadata.sharedWith === undefined || metadata.sharedWith.length === 0 ? null : (
        <>
          <KeyValue.Key>Shared with</KeyValue.Key>
          <KeyValue.Value data-document-shared-with="">
            <PeopleList people={metadata.sharedWith} />
          </KeyValue.Value>
        </>
      )}
      <KeyValue.Key>Authors</KeyValue.Key>
      <KeyValue.Value>
        {metadata.authors.length === 0 ? (
          <span className={styles["metadataEmpty"]}>Not specified</span>
        ) : (
          <PeopleList people={metadata.authors} />
        )}
      </KeyValue.Value>
      <KeyValue.Key>Created</KeyValue.Key>
      <KeyValue.Value>
        <time dateTime={metadata.createdAt}>{formatDate(metadata.createdAt)}</time>
      </KeyValue.Value>
      <KeyValue.Key>Updated</KeyValue.Key>
      <KeyValue.Value>
        <time dateTime={metadata.updatedAt}>{formatDate(metadata.updatedAt)}</time>
      </KeyValue.Value>
      {metadata.reviewers.length === 0 ? null : (
        <>
          <KeyValue.Key>Reviewers</KeyValue.Key>
          <KeyValue.Value>
            <PeopleList people={metadata.reviewers} />
          </KeyValue.Value>
        </>
      )}
      {metadata.approvers.length === 0 ? null : (
        <>
          <KeyValue.Key>Approvers</KeyValue.Key>
          <KeyValue.Value>
            <PeopleList people={metadata.approvers} />
          </KeyValue.Value>
        </>
      )}
      {metadata.targetDecisionDate === undefined ? null : (
        <>
          <KeyValue.Key>Target decision</KeyValue.Key>
          <KeyValue.Value>
            <time dateTime={metadata.targetDecisionDate}>
              {formatDate(metadata.targetDecisionDate)}
            </time>
          </KeyValue.Value>
        </>
      )}
    </KeyValue.Grid>
  );
}

/** The owner of a personal document, named as its authors name them when they do. */
function personalOwner(metadata: DocumentMetadataDto): DocumentMetadataDto["authors"][number] {
  const id = metadata.personalOwner ?? "";
  return (
    [...metadata.authors, ...metadata.reviewers, ...metadata.approvers].find(
      (person) => person.id === id,
    ) ?? { displayName: id, email: id, id }
  );
}

function PeopleList({
  people,
}: {
  readonly people: DocumentMetadataDto["authors"];
}): React.JSX.Element {
  return (
    <>
      {people.map((person, index) => (
        <span key={person.id}>
          {index === 0 ? null : ", "}
          <a href={`mailto:${person.email}`} title={person.email}>
            {person.displayName}
          </a>
        </span>
      ))}
    </>
  );
}

/**
 * Whether a media query matches, following changes. The server renders for
 * `serverMatches`, and hydration switches to the browser's answer.
 */
function useMediaQuery(query: string, serverMatches: boolean): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const media = matchMedia(query);
      media.addEventListener("change", onChange);
      return () => media.removeEventListener("change", onChange);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => matchMedia(query).matches,
    () => serverMatches,
  );
}
