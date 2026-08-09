import { useCallback, useEffect, useRef, useState } from "react";

import type { CatalogResponse } from "@earendil-works/inkling-protocol";

import { DocumentCatalogRow } from "./document-catalog-row.tsx";

export interface DocumentCatalogProps {
  readonly catalog: CatalogResponse;
  readonly publicCatalog?: boolean | undefined;
}

export function DocumentCatalog({
  catalog,
  publicCatalog = false,
}: DocumentCatalogProps): React.JSX.Element {
  const selectedDocumentRef = useRef<string | undefined>(undefined);
  const [selectedDocumentId, setSelectedDocumentId] = useState<string>();
  const selectDocument = useCallback((documentId: string, scroll: boolean): void => {
    selectedDocumentRef.current = documentId;
    setSelectedDocumentId(documentId);
    if (!scroll) return;
    requestAnimationFrame(() => {
      document
        .querySelector<HTMLElement>(`[data-catalog-document-id="${CSS.escape(documentId)}"]`)
        ?.scrollIntoView({ block: "nearest" });
    });
  }, []);
  const moveSelection = useCallback(
    (direction: -1 | 1): void => {
      const documents = catalog.documents;
      if (documents.length === 0) return;
      const currentIndex = documents.findIndex(
        (document) => document.metadata.id === selectedDocumentRef.current,
      );
      const nextIndex =
        currentIndex === -1
          ? direction === 1
            ? 0
            : documents.length - 1
          : Math.max(0, Math.min(documents.length - 1, currentIndex + direction));
      const nextDocument = documents[nextIndex];
      if (nextDocument !== undefined) selectDocument(nextDocument.metadata.id, true);
    },
    [catalog.documents, selectDocument],
  );

  useEffect(() => {
    const selected = selectedDocumentRef.current;
    if (
      selected !== undefined &&
      !catalog.documents.some((document) => document.metadata.id === selected)
    ) {
      selectedDocumentRef.current = undefined;
      setSelectedDocumentId(undefined);
    }
  }, [catalog.documents]);

  useEffect(() => {
    const handleKeyboardSelection = (event: KeyboardEvent): void => {
      if (catalog.documents.length === 0 || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (target instanceof Element && target.closest("dialog, [popover]") !== null) return;
      const editable = isEditableElement(target);
      const key = event.key.toLowerCase();
      const direction =
        event.key === "ArrowDown" || (key === "j" && !editable)
          ? 1
          : event.key === "ArrowUp" || (key === "k" && !editable)
            ? -1
            : undefined;
      if (direction === undefined) return;
      if (editable && !(target instanceof HTMLElement && target.matches("[data-search]"))) return;
      event.preventDefault();
      moveSelection(direction);
    };
    document.addEventListener("keydown", handleKeyboardSelection);
    return () => document.removeEventListener("keydown", handleKeyboardSelection);
  }, [catalog.documents.length, moveSelection]);

  if (catalog.documents.length === 0) {
    return (
      <section className="catalog" data-catalog="" aria-live="polite">
        <div className="empty-state">
          <span>Ø</span>
          <h2>No notes or RFCs found.</h2>
          <p>
            {publicCatalog
              ? "No public revisions have been published yet."
              : "Create one or adjust the search."}
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="catalog" data-catalog="" aria-live="polite">
      {catalog.documents.map((document) => (
        <DocumentCatalogRow
          document={document}
          key={document.metadata.id}
          onSelect={() => selectDocument(document.metadata.id, false)}
          publicDocument={publicCatalog}
          selected={document.metadata.id === selectedDocumentId}
        />
      ))}
    </section>
  );
}

function isEditableElement(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}
