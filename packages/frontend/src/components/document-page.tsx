import type { ReactNode } from "react";

import type { DocumentMetadataDto } from "@earendil-works/inkling-protocol";
import type { RenderHeading } from "@earendil-works/inkling-renderer";

import { formatDate } from "../ui.ts";
import { DocumentTableOfContents } from "./document-table-of-contents.tsx";
import { LifecycleStateChip } from "./lifecycle-state-chip.tsx";
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
  const folio =
    metadata.rfcNumber === undefined
      ? "Note"
      : `RFC ${String(metadata.rfcNumber).padStart(4, "0")}`;
  const visibilityQuery = `visibility:${metadata.visibility}`;

  return (
    <div
      className={`${styles["page"]}${presentation === "preview" ? ` ${styles["preview"]}` : ""}`}
      data-document-page=""
    >
      <header className={styles["heading"]}>
        <p className={styles["folio"]}>{folio}</p>
        <div className={styles["headingMain"]}>
          <div className={styles["badges"]}>
            <LifecycleStateChip
              className={styles["stateChip"]}
              href={`/?q=${encodeURIComponent(`state:${metadata.lifecycleState}`)}`}
              state={metadata.lifecycleState}
            />
            <a
              className={styles["visibilityChip"]}
              data-document-visibility={metadata.visibility}
              href={`/?q=${encodeURIComponent(visibilityQuery)}`}
            >
              {metadata.visibility}
            </a>
          </div>
          <h1>{metadata.title}</h1>
          {metadata.labels.length === 0 ? null : (
            <div className={styles["labels"]} aria-label="Labels">
              {metadata.labels.map((label) => (
                <a href={`/labels?label=${encodeURIComponent(label)}`} key={label}>
                  {label}
                </a>
              ))}
            </div>
          )}
        </div>
      </header>
      <DocumentMetadata metadata={metadata} />
      <div className={styles["contentGrid"]}>
        {children}
        <DocumentTableOfContents headings={headings} />
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
    <dl className={styles["metadata"]} data-document-metadata="">
      <MetadataRow label="Authors">
        {metadata.authors.length === 0 ? (
          <span className={styles["metadataEmpty"]}>Not specified</span>
        ) : (
          <PeopleList people={metadata.authors} />
        )}
      </MetadataRow>
      <MetadataRow label="Created">
        <time dateTime={metadata.createdAt}>{formatDate(metadata.createdAt)}</time>
      </MetadataRow>
      <MetadataRow label="Updated">
        <time dateTime={metadata.updatedAt}>{formatDate(metadata.updatedAt)}</time>
      </MetadataRow>
      {metadata.reviewers.length === 0 ? null : (
        <MetadataRow label="Reviewers">
          <PeopleList people={metadata.reviewers} />
        </MetadataRow>
      )}
      {metadata.approvers.length === 0 ? null : (
        <MetadataRow label="Approvers">
          <PeopleList people={metadata.approvers} />
        </MetadataRow>
      )}
      {metadata.targetDecisionDate === undefined ? null : (
        <MetadataRow label="Target decision">
          <time dateTime={metadata.targetDecisionDate}>
            {formatDate(metadata.targetDecisionDate)}
          </time>
        </MetadataRow>
      )}
    </dl>
  );
}

function MetadataRow({
  children,
  label,
}: {
  readonly children: ReactNode;
  readonly label: string;
}): React.JSX.Element {
  return (
    <div className={styles["metadataRow"]}>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
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
