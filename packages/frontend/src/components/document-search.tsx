import { useDeferredValue, useEffect, useId, useMemo, useRef, useState } from "react";

import { CloseIcon } from "@earendil-works/elanor-icons-react";
import { Button, IconButton, InlineCode, KeyboardKey, Search } from "@earendil-works/elanor-react";
import type { CatalogResponse } from "@earendil-works/inkling-protocol";

import type { ApiClientService } from "../api.ts";
import { useCurrentUrl } from "../app-context.tsx";
import { useEffectQuery } from "../effect-hooks.ts";
import { formatRfcNumber, isEditableElement } from "../ui.ts";
import styles from "./document-search.module.css";

interface SearchCompletion {
  readonly complete: boolean;
  readonly description: string;
  readonly token: string;
}

const operators: readonly { readonly description: string; readonly token: string }[] = [
  { description: "Filter by label", token: "label:" },
  { description: "Filter by lifecycle state", token: "state:" },
  { description: "Find an author or email", token: "author:" },
  { description: "Jump to an RFC number", token: "rfc:" },
  { description: "RFCs, notes, publications, or personal and shared documents", token: "is:" },
  { description: "Public, private, or confidential documents", token: "visibility:" },
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
  const inputRef = useRef<HTMLInputElement>(null);
  const currentUrl = useCurrentUrl();
  // The route loaded the catalog for the query in the URL, so start from it.
  const [initialQuery] = useState(() => currentUrl.searchParams.get("q") ?? "");
  const [query, setQuery] = useState(initialQuery);
  const [focused, setFocused] = useState(false);
  const deferredQuery = useDeferredValue(query);
  const searchKey = (value: string): string =>
    `document-search:${publicCatalog ? "public" : "workspace"}:${value}`;
  const search = useEffectQuery(
    publicCatalog ? api.listPublicDocuments(deferredQuery) : api.listDocuments(deferredQuery),
    searchKey(deferredQuery),
    { data: initialCatalog, key: searchKey(initialQuery) },
  );
  const inputId = useId();
  const panelId = `${inputId}-suggestions`;
  const pending = deferredQuery !== query || search.state.status === "loading";
  const completions = useMemo(
    () => (publicCatalog ? [] : searchCompletions(query, initialCatalog)),
    [initialCatalog, publicCatalog, query],
  );
  const failed = search.state.status === "failure" && !pending;
  const panelOpen = focused && (completions.length > 0 || failed);

  useEffect(() => {
    if (deferredQuery === query && search.state.status === "success") {
      onResultsChange(search.state.data);
    }
  }, [deferredQuery, onResultsChange, query, search.state]);

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
    requestAnimationFrame(() => {
      const input = inputRef.current;
      if (input === null) return;
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    });
  };

  return (
    <div
      aria-busy={pending}
      className={styles["root"]}
      data-document-search=""
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
      }}
    >
      <Search
        aria-autocomplete="list"
        aria-controls={panelId}
        aria-expanded={panelOpen}
        aria-haspopup="dialog"
        aria-label="Search Inkling"
        autoComplete="off"
        data-search=""
        endAdornment={
          query === "" ? (
            <KeyboardKey aria-label="Keyboard shortcut">/</KeyboardKey>
          ) : (
            <IconButton
              aria-label="Clear search"
              onClick={() => {
                updateQuery("");
                inputRef.current?.focus();
              }}
            >
              <CloseIcon />
            </IconButton>
          )
        }
        id={inputId}
        inputMode="search"
        maxLength={500}
        onFocus={() => setFocused(true)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            setFocused(false);
            return;
          }
          if (event.key === "Tab" && completions[0] !== undefined) {
            event.preventDefault();
            completeSearch(completions[0]);
            return;
          }
          if (event.key === "Enter") {
            event.preventDefault();
            setFocused(false);
          }
        }}
        onValueChange={updateQuery}
        placeholder={
          publicCatalog
            ? "Search published documents"
            : "Search text, or try label:platform -state:abandoned"
        }
        ref={inputRef}
        role="combobox"
        rootClassName={styles["control"] ?? ""}
        spellCheck={false}
        value={query}
      />
      {panelOpen ? (
        <div
          aria-label="Search suggestions"
          className={styles["panel"]}
          data-search-panel=""
          id={panelId}
          role="dialog"
        >
          {completions.length === 0 ? null : (
            <div className={styles["completions"]} data-search-completions="">
              <span className={styles["panelLabel"]}>
                {query.trim() === "" ? "Search syntax" : "Complete query"}
              </span>
              <div>
                {completions.map((completion) => (
                  <Button
                    density="compact"
                    hierarchy="secondary"
                    key={completion.token}
                    onClick={() => completeSearch(completion)}
                    title={completion.description}
                  >
                    <code>{completion.token}</code>
                    <small>{completion.description}</small>
                  </Button>
                ))}
              </div>
            </div>
          )}
          {search.state.status === "failure" && !pending ? (
            <p className={styles["error"]} role="alert">
              {search.state.error.message}
            </p>
          ) : null}
          {publicCatalog ? null : (
            <p className={styles["syntaxHint"]}>
              Combine filters with spaces. Quote phrases. Prefix any term with{" "}
              <InlineCode>-</InlineCode> to exclude it.
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
    return operators
      .filter((operator) => operator.token.startsWith(prefix))
      .map((operator) => ({
        complete: false,
        description: operator.description,
        token: `${negated ? "-" : ""}${operator.token}`,
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
            : [formatRfcNumber(document.metadata.rfcNumber)],
        );
      case "is":
        return [
          "rfc",
          "note",
          "personal",
          "shared",
          "published",
          "unpublished",
          "public",
          "private",
          "confidential",
        ];
      case "has":
        return ["rfc", "publication"];
      default:
        return [];
    }
  })();
  const completions = [...new Set(values)]
    .filter((value) => value.toLowerCase().includes(valuePrefix))
    .toSorted((left, right) => left.localeCompare(right))
    .slice(0, 6)
    .map((value) => ({
      complete: true,
      description: `Use ${field} filter`,
      token: `${negated ? "-" : ""}${field}:${quoteSearchValue(value)}`,
    }));
  if (
    !["approver", "author", "from", "person", "reviewer"].includes(field) ||
    !"me".startsWith(valuePrefix)
  ) {
    return completions;
  }
  const currentUserCompletion: SearchCompletion = {
    complete: true,
    description: "Use your account identity",
    token: `${negated ? "-" : ""}${field}:me`,
  };
  return [
    currentUserCompletion,
    ...completions.filter((completion) => completion.token !== currentUserCompletion.token),
  ].slice(0, 6);
}

function trailingSearchFragment(query: string): string {
  return /(?:^|\s)(\S*)$/u.exec(query)?.[1] ?? "";
}

function quoteSearchValue(value: string): string {
  return /\s/u.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value;
}
