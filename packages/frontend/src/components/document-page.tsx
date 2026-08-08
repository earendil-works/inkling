import type { ReactNode } from "react";

import type { DocumentMetadataDto } from "@earendil-works/inkling-protocol";
import type { RenderHeading } from "@earendil-works/inkling-renderer";

import { formatDate } from "../ui.ts";
import { DocumentTableOfContents } from "./document-table-of-contents.tsx";
import { LifecycleStateChip } from "./lifecycle-state-chip.tsx";

export interface DocumentPageProps {
  readonly children: ReactNode;
  readonly headings: readonly RenderHeading[];
  readonly metadata: DocumentMetadataDto;
}

export function DocumentPage({
  children,
  headings,
  metadata,
}: DocumentPageProps): React.JSX.Element {
  const folio =
    metadata.rfcNumber === undefined
      ? "Note"
      : `RFC ${String(metadata.rfcNumber).padStart(4, "0")}`;
  const visibilityQuery = `visibility:${metadata.visibility}`;

  return (
    <div className="document-page" data-document-page="">
      <header className="reader-heading">
        <p className="reader-folio">{folio}</p>
        <div className="reader-heading__main">
          <div className="reader-heading__badges">
            <LifecycleStateChip
              className="reader-state-chip"
              href={`/?q=${encodeURIComponent(`state:${metadata.lifecycleState}`)}`}
              state={metadata.lifecycleState}
            />
            <a
              className="reader-visibility-chip"
              data-document-visibility={metadata.visibility}
              href={`/?q=${encodeURIComponent(visibilityQuery)}`}
            >
              {metadata.visibility}
            </a>
          </div>
          <h1>{metadata.title}</h1>
          {metadata.labels.length === 0 ? null : (
            <div className="reader-labels" aria-label="Labels">
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
      <div className="reader-content-grid">
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
    <dl className="reader-metadata" data-document-metadata="">
      <MetadataRow label="Authors">
        {metadata.authors.length === 0 ? (
          <span className="reader-metadata__empty">Not specified</span>
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
    <div className="reader-metadata__row">
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
