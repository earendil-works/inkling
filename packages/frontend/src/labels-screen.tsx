import { useMemo } from "react";

import type { CatalogResponse } from "@earendil-works/jot-protocol";

import { ButtonLink } from "./components/button-link.tsx";
import { DocumentCatalog } from "./components/document-catalog.tsx";

export interface LabelsScreenProps {
  readonly catalog: CatalogResponse;
  readonly selectedLabel: string | undefined;
}

interface LabelGroup {
  readonly documents: CatalogResponse["documents"];
  readonly label: string;
}

export function LabelsScreen({ catalog, selectedLabel }: LabelsScreenProps): React.JSX.Element {
  const groups = useMemo(() => groupDocumentsByLabel(catalog), [catalog]);
  const selected =
    selectedLabel === undefined ? undefined : groups.find((group) => group.label === selectedLabel);

  return (
    <main className="workspace-layout labels-layout" id="app" tabIndex={-1}>
      <section className="workspace-heading labels-heading">
        <div>
          <p className="eyebrow">
            <a href="/">Notes and RFCs</a> / Labels
          </p>
          <h1>{selectedLabel ?? "Labels"}</h1>
        </div>
        <ButtonLink href="/" variant="text">
          All notes and RFCs
        </ButtonLink>
      </section>
      {selectedLabel === undefined ? (
        <LabelIndex groups={groups} />
      ) : (
        <section className="label-results" aria-live="polite">
          <div className="label-results__heading">
            <p>
              {selected === undefined
                ? "No notes or RFCs use this label."
                : `${selected.documents.length} ${selected.documents.length === 1 ? "entry" : "entries"}`}
            </p>
            <ButtonLink href="/labels" variant="text">
              Browse all labels
            </ButtonLink>
          </div>
          <DocumentCatalog catalog={{ documents: selected?.documents ?? [] }} />
        </section>
      )}
    </main>
  );
}

function LabelIndex({ groups }: { readonly groups: readonly LabelGroup[] }): React.JSX.Element {
  if (groups.length === 0) {
    return (
      <section className="empty-state" data-label-index="">
        <span>Ø</span>
        <h2>No labels yet.</h2>
        <p>Add labels in a note or RFC’s Markdown frontmatter.</p>
      </section>
    );
  }

  return (
    <section className="label-index" data-label-index="" aria-label="Labels">
      {groups.map((group) => (
        <a
          className="label-index__item"
          href={`/labels?label=${encodeURIComponent(group.label)}`}
          key={group.label}
        >
          <span className="label-index__name">{group.label}</span>
          <span className="label-index__documents">
            {group.documents
              .slice(0, 3)
              .map((document) => document.metadata.title)
              .join(" · ")}
          </span>
          <span className="label-index__count">
            {group.documents.length} {group.documents.length === 1 ? "entry" : "entries"}
          </span>
        </a>
      ))}
    </section>
  );
}

function groupDocumentsByLabel(catalog: CatalogResponse): readonly LabelGroup[] {
  const documentsByLabel = new Map<string, CatalogResponse["documents"]>();
  for (const document of catalog.documents) {
    for (const label of document.metadata.labels) {
      const documents = documentsByLabel.get(label) ?? [];
      documentsByLabel.set(label, [...documents, document]);
    }
  }
  return [...documentsByLabel]
    .map(([label, documents]) => ({ documents, label }))
    .toSorted((left, right) => left.label.localeCompare(right.label));
}
