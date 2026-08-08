import { useDeferredValue, useEffect, useId, useMemo, useRef, useState } from "react";

import type { CatalogResponse } from "@earendil-works/inkling-protocol";

import type { ApiClientService } from "../api.ts";
import { useAppContext } from "../app-context.tsx";
import { useEffectQuery } from "../effect-hooks.ts";
import { documentHref, publicDocumentHref } from "../ui.ts";
import { LifecycleStateChip } from "./lifecycle-state-chip.tsx";

interface SearchCompletion {
  readonly complete: boolean;
  readonly description: string;
  readonly token: string;
}

const operatorCompletions: readonly SearchCompletion[] = [
  { complete: false, description: "Filter by label", token: "label:" },
  { complete: false, description: "Filter by lifecycle state", token: "state:" },
  { complete: false, description: "Find an author or email", token: "author:" },
  { complete: false, description: "Jump to an RFC number", token: "rfc:" },
  { complete: false, description: "RFCs, notes, or publications", token: "is:" },
  {
    complete: false,
    description: "Public, private, or confidential documents",
    token: "visibility:",
  },
];

export interface DocumentSearchProps {
  readonly api: ApiClientService;
  readonly initialCatalog: CatalogResponse;
  readonly onResultsChange: (catalog: CatalogResponse) => void;
  readonly publicCatalog?: boolean | undefined;
}

export function DocumentSearch({
  api,
  initialCatalog,
  onResultsChange,
  publicCatalog = false,
}: DocumentSearchProps): React.JSX.Element {
  const { navigate } = useAppContext();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState(() => new URL(location.href).searchParams.get("q") ?? "");
  const [focused, setFocused] = useState(false);
  const [activeResult, setActiveResult] = useState(-1);
  const deferredQuery = useDeferredValue(query);
  const search = useEffectQuery(
    publicCatalog ? api.listPublicDocuments(deferredQuery) : api.listDocuments(deferredQuery),
    `document-search:${publicCatalog ? "public" : "workspace"}:${deferredQuery}`,
  );
  const inputId = useId();
  const listboxId = `${inputId}-results`;
  const pending = deferredQuery !== query || search.state.status === "loading";
  const displayedCatalog = search.state.data ?? initialCatalog;
  const topResults = useMemo(
    () => displayedCatalog.documents.slice(0, 8),
    [displayedCatalog.documents],
  );
  const completions = useMemo(
    () => (publicCatalog ? [] : searchCompletions(query, initialCatalog)),
    [initialCatalog, publicCatalog, query],
  );
  const panelOpen = focused && (query.trim() !== "" || completions.length > 0);

  useEffect(() => {
    if (deferredQuery === query && search.state.status === "success") {
      onResultsChange(search.state.data);
    }
  }, [deferredQuery, onResultsChange, query, search.state]);

  useEffect(() => {
    setActiveResult(topResults.length === 0 ? -1 : 0);
  }, [topResults]);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent): void => {
      const slash = event.key === "/" && !event.metaKey && !event.ctrlKey && !event.altKey;
      const commandK = event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey);
      if ((!slash && !commandK) || (slash && isEditableElement(document.activeElement))) return;
      event.preventDefault();
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    document.addEventListener("keydown", handleShortcut);
    return () => document.removeEventListener("keydown", handleShortcut);
  }, []);

  const updateQuery = (nextQuery: string): void => {
    setQuery(nextQuery);
    setFocused(true);
    const url = new URL(location.href);
    if (nextQuery.trim() === "") url.searchParams.delete("q");
    else url.searchParams.set("q", nextQuery.trim());
    history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  };

  const completeSearch = (completion: SearchCompletion): void => {
    const fragment = trailingSearchFragment(query);
    const prefix = query.slice(0, query.length - fragment.length);
    updateQuery(`${prefix}${completion.token}${completion.complete ? " " : ""}`);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const resultHref = (document: CatalogResponse["documents"][number]): string =>
    publicCatalog
      ? publicDocumentHref(document.metadata.id, document.metadata.rfcNumber)
      : documentHref(document.metadata.id, document.metadata.rfcNumber, false, "read", "");

  const openResult = (index: number): void => {
    const result = topResults[index];
    if (result === undefined) return;
    const href = resultHref(result);
    if (publicCatalog) location.assign(href);
    else navigate(href);
  };

  return (
    <div
      className="document-search"
      data-document-search=""
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
      }}
    >
      <label className="document-search__label" htmlFor={inputId}>
        Search Inkling
      </label>
      <div className="document-search__control">
        <svg aria-hidden="true" viewBox="0 0 24 24">
          <circle cx="10.5" cy="10.5" r="6.5" />
          <path d="m15.5 15.5 5 5" />
        </svg>
        <input
          aria-activedescendant={
            activeResult === -1 ? undefined : `${listboxId}-result-${activeResult}`
          }
          aria-autocomplete="list"
          aria-controls={listboxId}
          aria-expanded={panelOpen}
          aria-haspopup="listbox"
          autoComplete="off"
          data-search=""
          id={inputId}
          inputMode="search"
          maxLength={500}
          onChange={(event) => updateQuery(event.currentTarget.value)}
          onFocus={() => setFocused(true)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setFocused(false);
              return;
            }
            if (event.key === "Enter") {
              if (activeResult !== -1) {
                event.preventDefault();
                openResult(activeResult);
              }
              return;
            }
            if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
            if (topResults.length === 0) return;
            event.preventDefault();
            setActiveResult((current) =>
              event.key === "ArrowDown"
                ? current < topResults.length - 1
                  ? current + 1
                  : 0
                : current > 0
                  ? current - 1
                  : topResults.length - 1,
            );
          }}
          placeholder={
            publicCatalog
              ? "Search published documents"
              : "Search text, or try label:platform -state:abandoned"
          }
          ref={inputRef}
          role="combobox"
          spellCheck={false}
          type="search"
          value={query}
        />
        {query === "" ? (
          <kbd aria-label="Keyboard shortcut">/</kbd>
        ) : (
          <button aria-label="Clear search" onClick={() => updateQuery("")} type="button">
            Clear
          </button>
        )}
      </div>
      {panelOpen ? (
        <div className="document-search__panel" data-search-panel="">
          {completions.length === 0 ? null : (
            <div className="document-search__completions" data-search-completions="">
              <span>{query.trim() === "" ? "Search syntax" : "Complete query"}</span>
              <div>
                {completions.map((completion) => (
                  <button
                    key={completion.token}
                    onClick={() => completeSearch(completion)}
                    title={completion.description}
                    type="button"
                  >
                    <code>{completion.token}</code>
                    <small>{completion.description}</small>
                  </button>
                ))}
              </div>
            </div>
          )}
          <div
            aria-busy={pending}
            aria-label="Document search results"
            className="document-search__results"
            id={listboxId}
            role="listbox"
          >
            {query.trim() === "" ? null : search.state.status === "failure" && !pending ? (
              <p className="document-search__message is-error" role="alert">
                {search.state.error.message}
              </p>
            ) : topResults.length === 0 ? (
              <p aria-live="polite" className="document-search__message">
                {pending
                  ? publicCatalog
                    ? "Searching published documents…"
                    : "Searching titles, metadata, and complete working heads…"
                  : "No document matches this query."}
              </p>
            ) : (
              <>
                <div className="document-search__result-heading">
                  <span>Top matches</span>
                  <small>{displayedCatalog.documents.length} found</small>
                </div>
                {topResults.map((document, index) => {
                  const { metadata } = document;
                  const folio =
                    metadata.rfcNumber === undefined
                      ? "NOTE"
                      : `RFC ${String(metadata.rfcNumber).padStart(4, "0")}`;
                  return (
                    <a
                      aria-selected={activeResult === index}
                      className="document-search__result"
                      data-native-navigation={publicCatalog ? "" : undefined}
                      data-search-result=""
                      href={resultHref(document)}
                      id={`${listboxId}-result-${index}`}
                      key={metadata.id}
                      onPointerMove={() => setActiveResult(index)}
                      role="option"
                    >
                      <span className="document-search__result-title">
                        <b>{metadata.title}</b>
                        <em>{folio}</em>
                      </span>
                      <span className="document-search__result-excerpt">
                        {document.excerpt || "No body text yet"}
                      </span>
                      <span className="document-search__result-meta">
                        <LifecycleStateChip state={metadata.lifecycleState} />
                        {metadata.labels.slice(0, 3).map((label) => (
                          <i key={label}>{label}</i>
                        ))}
                      </span>
                    </a>
                  );
                })}
              </>
            )}
          </div>
          {publicCatalog ? null : (
            <p className="document-search__syntax-hint">
              Combine filters with spaces. Quote phrases. Prefix any term with <code>-</code> to
              exclude it.
            </p>
          )}
        </div>
      ) : null}
    </div>
  );
}

function searchCompletions(query: string, catalog: CatalogResponse): readonly SearchCompletion[] {
  const fragment = trailingSearchFragment(query);
  const negated = fragment.startsWith("-");
  const candidate = negated ? fragment.slice(1) : fragment;
  const separator = candidate.indexOf(":");
  if (separator === -1) {
    const prefix = candidate.toLowerCase();
    return operatorCompletions
      .filter((completion) => completion.token.startsWith(prefix))
      .slice(0, 6)
      .map((completion) => ({
        complete: completion.complete,
        description: completion.description,
        token: `${negated ? "-" : ""}${completion.token}`,
      }));
  }

  const field = candidate.slice(0, separator).toLowerCase();
  const valuePrefix = candidate
    .slice(separator + 1)
    .replace(/^['"]|['"]$/gu, "")
    .toLowerCase();
  const documents = catalog.documents;
  const values = (() => {
    switch (field) {
      case "label":
      case "tag":
        return documents.flatMap((document) => document.metadata.labels);
      case "state":
      case "status":
        return documents.map((document) => document.metadata.lifecycleState);
      case "visibility":
        return ["public", "private", "confidential"];
      case "author":
      case "from":
        return documents.flatMap((document) =>
          document.metadata.authors.flatMap((person) => [person.displayName, person.email]),
        );
      case "reviewer":
        return documents.flatMap((document) =>
          document.metadata.reviewers.flatMap((person) => [person.displayName, person.email]),
        );
      case "approver":
        return documents.flatMap((document) =>
          document.metadata.approvers.flatMap((person) => [person.displayName, person.email]),
        );
      case "person":
        return documents.flatMap((document) =>
          [
            ...document.metadata.authors,
            ...document.metadata.reviewers,
            ...document.metadata.approvers,
          ].flatMap((person) => [person.displayName, person.email]),
        );
      case "rfc":
        return documents.flatMap((document) =>
          document.metadata.rfcNumber === undefined
            ? []
            : [String(document.metadata.rfcNumber).padStart(4, "0")],
        );
      case "is":
        return ["rfc", "note", "published", "unpublished", "public", "private", "confidential"];
      case "has":
        return ["rfc", "publication"];
      default:
        return [];
    }
  })();
  return [...new Set(values)]
    .filter((value) => value.toLowerCase().includes(valuePrefix))
    .toSorted((left, right) => left.localeCompare(right))
    .slice(0, 6)
    .map((value) => ({
      complete: true,
      description: `Use ${field} filter`,
      token: `${negated ? "-" : ""}${field}:${quoteSearchValue(value)}`,
    }));
}

function trailingSearchFragment(query: string): string {
  return /(?:^|\s)(\S*)$/u.exec(query)?.[1] ?? "";
}

function quoteSearchValue(value: string): string {
  return /\s/u.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value;
}

function isEditableElement(element: Element | null): boolean {
  return (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    (element instanceof HTMLElement && element.isContentEditable)
  );
}
