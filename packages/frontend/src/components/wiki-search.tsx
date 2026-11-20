import { useEffect, useState } from "react";
import { Effect, Fiber } from "effect";

import {
  EmptyState,
  KeyboardKey,
  KeyboardShortcut,
  SearchDialog,
} from "@earendil-works/elanor-react";
import { wikiLabel } from "@earendil-works/inkling-core";
import type { SearchPassageDto } from "@earendil-works/inkling-protocol";

import type { ApiClientService } from "../api.ts";
import { useAppContext } from "../app-context.tsx";
import { browserRuntime } from "../effect-runtime.ts";
import { documentHref } from "../ui.ts";

/*
 * The wiki's search, like pi.dev's docs: Elanor's search dialog, opened from
 * the side navigation's field, the top bar's button on narrow screens, ⌘K or
 * Ctrl+K, and `/`. It searches the passages of the wiki's pages with Inkling's
 * search (`label:wiki`), as far as the reader may read them.
 */

/** Opens the wiki's search from anywhere on the page. */
export const wikiSearch = SearchDialog.createHandle();

type SearchState =
  | { readonly status: "idle" }
  | { readonly status: "loading"; readonly query: string }
  | {
      readonly status: "done";
      readonly query: string;
      readonly passages: readonly SearchPassageDto[];
    }
  | { readonly status: "error"; readonly query: string };

/**
 * A section's id as Inkling's renderer derives it from the heading's text, so
 * a result leads to its section. Headings that pin another id lead to the page.
 */
function sectionId(heading: string): string {
  const slug = heading
    .normalize("NFKD")
    .toLocaleLowerCase("en")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-|-$/gu, "");
  return slug.length === 0 ? "section" : slug;
}

/** A passage's text without Markdown's heading markers, emphasis, and link syntax. */
function plainSnippet(snippet: string): string {
  return snippet
    .replace(/(^|\s)#{1,6}\s+/gu, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/[*_`]+/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function resultHref(passage: SearchPassageDto): string {
  const page = documentHref(passage.documentId, passage.rfcNumber, false, "read", "");
  const heading = passage.headingPath.at(-1);
  return heading === undefined ? page : `${page}#${encodeURIComponent(sectionId(heading))}`;
}

/** Where a result sits: its page, and the sections above its own. */
function resultContext(passage: SearchPassageDto): string {
  const sections = passage.headingPath.filter((heading) => heading !== passage.title);
  return [passage.title, ...sections.slice(0, -1)].join(" › ");
}

function isApplePlatform(): boolean {
  const platform =
    (navigator as Navigator & { userAgentData?: { platform: string } }).userAgentData?.platform ??
    navigator.platform;
  return /^(mac|iphone|ipad|ipod)/iu.test(platform);
}

/** The search field atop the side navigation, with its shortcut. */
export function WikiSearchTrigger(): React.JSX.Element {
  const [apple, setApple] = useState(false);
  useEffect(() => setApple(isApplePlatform()), []);
  return (
    <SearchDialog.Trigger
      aria-keyshortcuts={apple ? "Meta+K" : "Control+K"}
      data-wiki-search-trigger=""
      handle={wikiSearch}
      shortcut={
        <KeyboardShortcut>
          <KeyboardKey>{apple ? "⌘" : "Ctrl"}</KeyboardKey>
          <KeyboardKey>K</KeyboardKey>
        </KeyboardShortcut>
      }
    >
      Search wiki
    </SearchDialog.Trigger>
  );
}

function SearchMessage({
  title,
  children,
}: {
  readonly title: string;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <SearchDialog.Message>
      <EmptyState.Root>
        <EmptyState.Body>
          <EmptyState.Copy>
            <EmptyState.Title level={2}>{title}</EmptyState.Title>
            <EmptyState.Description>{children}</EmptyState.Description>
          </EmptyState.Copy>
        </EmptyState.Body>
      </EmptyState.Root>
    </SearchDialog.Message>
  );
}

/** The dialog, and the page's shortcuts for opening it. */
export function WikiSearchDialog({
  api,
}: {
  readonly api: ApiClientService | undefined;
}): React.JSX.Element {
  const { navigate } = useAppContext();
  const [query, setQuery] = useState("");
  const [state, setState] = useState<SearchState>({ status: "idle" });
  const terms = query.trim();

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.defaultPrevented || event.isComposing || event.altKey) return;
      const target = event.target;
      const shortcut =
        event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey) && !event.shiftKey;
      const slash =
        event.key === "/" &&
        !event.metaKey &&
        !event.ctrlKey &&
        !(
          target instanceof Element && target.closest("input, textarea, select, [contenteditable]")
        );
      if (!shortcut && !slash) return;
      event.preventDefault();
      wikiSearch.open(null);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (api === undefined || terms.length < 2) {
      setState({ status: "idle" });
      return;
    }
    setState({ query: terms, status: "loading" });
    // Waits for a pause in typing; a newer query interrupts the older search.
    const fiber = browserRuntime.runFork(
      Effect.sleep("150 millis").pipe(
        Effect.zipRight(api.searchPassages(`label:${wikiLabel} ${terms}`, 20)),
        Effect.match({
          onFailure: (): SearchState => ({ query: terms, status: "error" }),
          onSuccess: (response): SearchState => ({
            passages: response.passages,
            query: terms,
            status: "done",
          }),
        }),
        Effect.flatMap((next) => Effect.sync(() => setState(next))),
      ),
    );
    return () => {
      browserRuntime.runFork(Fiber.interrupt(fiber));
    };
  }, [api, terms]);

  const passages = state.status === "done" ? state.passages : [];
  return (
    <SearchDialog.Root handle={wikiSearch} onOpenChange={(open) => open && setQuery("")}>
      <SearchDialog.Popup
        aria-label="Search the wiki"
        data-wiki-search=""
        onValueChange={setQuery}
        value={query}
      >
        {/* Enter without a selected result opens the first one. Results arrive after the query
            changes, and the dialog highlights the first result only when they arrive with it. */}
        <SearchDialog.Form
          onSubmit={(event) => {
            event.preventDefault();
            const first = passages[0];
            if (first === undefined) return;
            wikiSearch.close();
            navigate(resultHref(first));
          }}
        >
          <SearchDialog.Input placeholder="Search the wiki" />
          <SearchDialog.Close aria-label="Close search" />
        </SearchDialog.Form>
        <SearchDialog.Results>
          <SearchDialog.Status>
            {state.status === "done"
              ? `${passages.length} ${passages.length === 1 ? "result" : "results"}`
              : ""}
          </SearchDialog.Status>
          {terms.length < 2 ? (
            <SearchMessage title="Search the wiki">
              Find pages and their sections by title or content.
            </SearchMessage>
          ) : state.status === "error" ? (
            <SearchMessage title="Search isn’t available">
              The search didn’t answer. Try again, or browse the navigation.
            </SearchMessage>
          ) : state.status === "done" && passages.length === 0 ? (
            <SearchMessage title="No results">
              Nothing in the wiki matches “{terms}”. Try other words, or browse the navigation.
            </SearchMessage>
          ) : null}
          <SearchDialog.List aria-label="Results">
            {passages.map((passage) => (
              <SearchDialog.Result
                href={resultHref(passage)}
                key={`${passage.documentId}:${passage.startLine}`}
              >
                <SearchDialog.ResultContext>{resultContext(passage)}</SearchDialog.ResultContext>
                <SearchDialog.ResultTitle>
                  {passage.headingPath.at(-1) ?? passage.title}
                </SearchDialog.ResultTitle>
                <SearchDialog.ResultExcerpt>
                  {plainSnippet(passage.snippet)}
                </SearchDialog.ResultExcerpt>
              </SearchDialog.Result>
            ))}
          </SearchDialog.List>
        </SearchDialog.Results>
        <SearchDialog.Footer>
          <SearchDialog.Hint>
            <KeyboardShortcut>
              <KeyboardKey>↑</KeyboardKey>
              <KeyboardKey>↓</KeyboardKey>
            </KeyboardShortcut>
            to select
          </SearchDialog.Hint>
          <SearchDialog.Hint>
            <KeyboardKey>↵</KeyboardKey>
            to open
          </SearchDialog.Hint>
          <SearchDialog.Hint>
            <KeyboardKey>Esc</KeyboardKey>
            to close
          </SearchDialog.Hint>
        </SearchDialog.Footer>
      </SearchDialog.Popup>
    </SearchDialog.Root>
  );
}
