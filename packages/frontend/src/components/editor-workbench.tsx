import { useEffect, useRef, useState } from "react";
import { markdown } from "@codemirror/lang-markdown";
import { yamlFrontmatter } from "@codemirror/lang-yaml";
import { syntaxHighlighting } from "@codemirror/language";
import { Compartment, EditorState, StateEffect, StateField } from "@codemirror/state";
import type { Range, Text } from "@codemirror/state";
import { oneDarkTheme } from "@codemirror/theme-one-dark";
import { Decoration } from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";
import { basicSetup, EditorView } from "codemirror";
import { Effect, Fiber } from "effect";

import type { DocumentMetadataDto } from "@earendil-works/inkling-protocol";
import {
  findInklingCodeLanguage,
  inklingSyntaxHighlighter,
} from "@earendil-works/inkling-renderer";
import type { RenderHeading } from "@earendil-works/inkling-renderer";

import type { ConnectionState } from "../collaboration.ts";
import { selectedPreviewSourceRange } from "../comments.ts";
import type { PreviewSourceRange } from "../comments.ts";
import { browserRuntime } from "../effect-runtime.ts";
import type { HistoryChangeRange } from "../history-diff.ts";
import { renderMermaid } from "../markdown.tsx";
import { Button } from "./button.tsx";
import { DocumentPage } from "./document-page.tsx";
import styles from "./editor.module.css";
import markdownStyles from "./markdown-article.module.css";

export interface EditorWorkbenchProps {
  readonly connectionState: ConnectionState;
  readonly editor: EditorView | undefined;
  readonly editorHostRef: React.RefObject<HTMLDivElement | null>;
  readonly onClosePreview: () => void;
  readonly onPreviewRendered: () => void;
  readonly onPreviewSelection: (range: PreviewSourceRange | undefined) => void;
  readonly historyBody?: string | undefined;
  readonly historyChanges?: readonly HistoryChangeRange[] | undefined;
  readonly previewHeadings: readonly RenderHeading[];
  readonly previewHtml: string;
  readonly previewLabel?: string | undefined;
  readonly previewRef: React.RefObject<HTMLElement | null>;
  readonly metadata: DocumentMetadataDto;
  readonly readOnly: boolean;
}

export function EditorWorkbench({
  connectionState,
  editor,
  editorHostRef,
  onClosePreview,
  onPreviewRendered,
  onPreviewSelection,
  historyBody,
  historyChanges = emptyHistoryChanges,
  previewHeadings,
  previewHtml,
  previewLabel,
  previewRef,
  metadata,
  readOnly,
}: EditorWorkbenchProps): React.JSX.Element {
  const renderedCallbackRef = useRef(onPreviewRendered);
  const previewScrollerRef = useRef<HTMLDivElement>(null);
  const historyEditorHostRef = useRef<HTMLDivElement>(null);
  const historyEditor = useHistoricalMarkdownEditor(
    historyBody,
    historyChanges,
    historyEditorHostRef,
  );
  renderedCallbackRef.current = onPreviewRendered;
  useSynchronizedScrolling(
    historyEditor ?? editor,
    historyBody === undefined ? editorHostRef : historyEditorHostRef,
    previewRef,
    previewScrollerRef,
  );

  useEffect(() => {
    const preview = previewRef.current;
    if (preview === null) return;
    preview.innerHTML = previewHtml;
    if (previewHtml === "") {
      renderedCallbackRef.current();
      return;
    }
    const changedElements = markChangedPreviewBlocks(preview, historyChanges);
    const highlightTimer =
      changedElements.length === 0
        ? undefined
        : window.setTimeout(() => clearPreviewHighlights(changedElements), highlightDuration);
    const fiber = browserRuntime.runFork(
      renderMermaid(preview).pipe(
        Effect.ensuring(Effect.sync(() => renderedCallbackRef.current())),
      ),
    );
    return () => {
      if (highlightTimer !== undefined) window.clearTimeout(highlightTimer);
      clearPreviewHighlights(changedElements);
      browserRuntime.runFork(Fiber.interrupt(fiber));
    };
  }, [historyChanges, previewHtml, previewRef]);

  const capturePreviewSelection = (): void => {
    window.setTimeout(() => {
      const preview = previewRef.current;
      onPreviewSelection(preview === null ? undefined : selectedPreviewSourceRange(preview));
    });
  };

  return (
    <section className={styles["workbench"]}>
      <div className={styles["sourcePane"]} data-source-pane="">
        <div className={styles["paneLabel"]} data-pane-label="">
          <span>
            {historyBody === undefined
              ? "Markdown"
              : `${previewLabel ?? "Historical version"} · Markdown`}
          </span>
          <span data-save-state="">
            {historyBody === undefined ? connectionLabel(connectionState) : "Read-only history"}
          </span>
        </div>
        {historyBody === undefined ? null : (
          <div
            className={styles["editorHost"]}
            data-editor=""
            data-history-editor=""
            ref={historyEditorHostRef}
          />
        )}
        <div
          className={styles["editorHost"]}
          data-editor={historyBody === undefined ? "" : undefined}
          data-live-editor=""
          hidden={historyBody !== undefined}
          ref={editorHostRef}
        />
      </div>
      <div className={styles["previewPane"]} data-preview-pane="">
        <div className={styles["paneLabel"]} data-pane-label="">
          <span>{previewLabel ?? "Preview"}</span>
          <Button
            aria-label="Close preview"
            className={styles["closePreview"]}
            variant="icon"
            data-preview-close=""
            onClick={onClosePreview}
          >
            ×
          </Button>
        </div>
        <div className={styles["previewPage"]} data-preview-scroller="" ref={previewScrollerRef}>
          <div className={styles["previewPaper"]}>
            <DocumentPage headings={previewHeadings} metadata={metadata} presentation="preview">
              <article
                aria-label="Rendered document preview"
                className={`${markdownStyles["body"]} ${markdownStyles["documentBody"]}${
                  readOnly ? ` ${markdownStyles["readOnly"]}` : ""
                }`}
                data-preview=""
                onPointerUp={capturePreviewSelection}
                ref={previewRef}
              />
            </DocumentPage>
          </div>
        </div>
      </div>
    </section>
  );
}

const emptyHistoryChanges: readonly HistoryChangeRange[] = [];
const highlightDuration = 1_300;
const replaceHistoryHighlights = StateEffect.define<readonly HistoryChangeRange[]>();
const historyHighlightField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  provide: (field) => EditorView.decorations.from(field),
  update: (decorations, transaction) => {
    let next = decorations.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (effect.is(replaceHistoryHighlights)) {
        next = historyLineDecorations(transaction.state.doc, effect.value);
      }
    }
    return next;
  },
});

function useHistoricalMarkdownEditor(
  body: string | undefined,
  changes: readonly HistoryChangeRange[],
  hostRef: React.RefObject<HTMLDivElement | null>,
): EditorView | undefined {
  const [editor, setEditor] = useState<EditorView>();
  const bodyRef = useRef(body);
  const active = body !== undefined;
  bodyRef.current = body;

  useEffect(() => {
    if (!active) {
      setEditor(undefined);
      return;
    }
    const parent = hostRef.current;
    if (parent === null) return;

    const theme = new Compartment();
    const created = new EditorView({
      parent,
      state: EditorState.create({
        doc: bodyRef.current ?? "",
        extensions: [
          basicSetup,
          syntaxHighlighting(inklingSyntaxHighlighter),
          yamlFrontmatter({
            content: markdown({ codeLanguages: findInklingCodeLanguage }),
          }),
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          historyHighlightField,
          theme.of(document.documentElement.dataset["theme"] === "dark" ? oneDarkTheme : []),
          EditorView.lineWrapping,
        ],
      }),
    });
    const themeObserver = new MutationObserver(() => {
      created.dispatch({
        effects: theme.reconfigure(
          document.documentElement.dataset["theme"] === "dark" ? oneDarkTheme : [],
        ),
      });
    });
    themeObserver.observe(document.documentElement, {
      attributeFilter: ["data-theme"],
      attributes: true,
    });
    setEditor(created);
    return () => {
      themeObserver.disconnect();
      created.destroy();
    };
  }, [active, hostRef]);

  useEffect(() => {
    if (body === undefined || editor === undefined) return;
    const current = editor.state.doc.toString();
    const effects: StateEffect<unknown>[] = [replaceHistoryHighlights.of(changes)];
    const firstChange = changes[0];
    if (firstChange !== undefined) {
      effects.push(
        EditorView.scrollIntoView(Math.min(firstChange.from, body.length), { y: "center" }),
      );
    }
    editor.dispatch(
      current === body
        ? { effects }
        : { changes: { from: 0, insert: body, to: current.length }, effects },
    );
    if (changes.length === 0) return;
    const timer = window.setTimeout(() => {
      editor.dispatch({ effects: replaceHistoryHighlights.of(emptyHistoryChanges) });
    }, highlightDuration);
    return () => window.clearTimeout(timer);
  }, [body, changes, editor]);

  return active ? editor : undefined;
}

function historyLineDecorations(
  document: Text,
  changes: readonly HistoryChangeRange[],
): DecorationSet {
  const decorations: Range<Decoration>[] = [];
  const decoratedLines = new Set<number>();
  for (const change of changes) {
    const from = Math.max(0, Math.min(change.from, document.length));
    const target = Math.max(from, Math.min(Math.max(change.from, change.to - 1), document.length));
    let line = document.lineAt(from);
    while (true) {
      if (!decoratedLines.has(line.from)) {
        decoratedLines.add(line.from);
        decorations.push(
          Decoration.line({
            attributes: { "data-history-change": "" },
            class: styles["historyChangedLine"] ?? "",
          }).range(line.from),
        );
      }
      if (line.to >= target || line.number === document.lines) break;
      line = document.line(line.number + 1);
    }
  }
  return Decoration.set(decorations, true);
}

function markChangedPreviewBlocks(
  preview: HTMLElement,
  changes: readonly HistoryChangeRange[],
): readonly HTMLElement[] {
  if (changes.length === 0) return [];
  const overlapping = [
    ...preview.querySelectorAll<HTMLElement>("[data-inkling-source-start]"),
  ].filter((element) => elementOverlapsChanges(element, changes));
  const selected = new Set(overlapping);
  for (const element of overlapping) {
    let parent = element.parentElement;
    while (parent !== null && parent !== preview) {
      selected.delete(parent);
      parent = parent.parentElement;
    }
  }
  const elements = [...selected];
  const className = styles["historyChangedPreview"];
  for (const element of elements) {
    if (className !== undefined) element.classList.add(className);
    element.dataset["historyChange"] = "";
  }
  return elements;
}

function elementOverlapsChanges(
  element: HTMLElement,
  changes: readonly HistoryChangeRange[],
): boolean {
  const start = Number(element.dataset["inklingSourceStart"]);
  const end = Number(element.dataset["inklingSourceEnd"]);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
  return changes.some((change) =>
    change.from === change.to
      ? start <= change.from && change.from <= end
      : start < change.to && change.from < end,
  );
}

function clearPreviewHighlights(elements: readonly HTMLElement[]): void {
  const className = styles["historyChangedPreview"];
  for (const element of elements) {
    if (className !== undefined) element.classList.remove(className);
    delete element.dataset["historyChange"];
  }
}

interface PreviewSourceSegment {
  readonly bottom: number;
  readonly end: number;
  readonly element: HTMLElement;
  readonly start: number;
  readonly top: number;
}

interface ScrollMapPoint {
  readonly preview: number;
  readonly source: number;
}

const synchronizationLineOffset = 3;

function useSynchronizedScrolling(
  editor: EditorView | undefined,
  editorHostRef: React.RefObject<HTMLDivElement | null>,
  previewRef: React.RefObject<HTMLElement | null>,
  previewScrollerRef: React.RefObject<HTMLDivElement | null>,
): void {
  useEffect(() => {
    const editorHost = editorHostRef.current;
    const preview = previewRef.current;
    const previewScroller = previewScrollerRef.current;
    if (
      editor === undefined ||
      editorHost === null ||
      preview === null ||
      previewScroller === null
    ) {
      return;
    }

    let scrollMap: readonly ScrollMapPoint[] | undefined;
    let scrollMapSourceHeight: number | undefined;
    let syncFrame: number | undefined;
    const programmaticScrollTops = new WeakMap<HTMLElement, number>();
    const invalidateScrollMap = (): void => {
      scrollMap = undefined;
      scrollMapSourceHeight = undefined;
    };
    const currentScrollMap = (): readonly ScrollMapPoint[] => {
      const sourceHeight = editor.contentHeight;
      if (scrollMap === undefined || scrollMapSourceHeight !== sourceHeight) {
        scrollMap = collectScrollMap(editor, preview, previewScroller);
        scrollMapSourceHeight = sourceHeight;
      }
      return scrollMap;
    };

    const queueSync = (source: HTMLElement, target: HTMLElement, synchronize: () => void): void => {
      const expectedScrollTop = programmaticScrollTops.get(source);
      if (expectedScrollTop !== undefined) {
        if (Math.abs(source.scrollTop - expectedScrollTop) < 1) return;
        programmaticScrollTops.delete(source);
      }
      if (syncFrame !== undefined) cancelAnimationFrame(syncFrame);
      syncFrame = requestAnimationFrame(() => {
        syncFrame = undefined;
        synchronize();
        programmaticScrollTops.set(target, target.scrollTop);
      });
    };

    const synchronizeFromSource = (event: Event): void => {
      const source = event.target;
      if (!(source instanceof HTMLElement) || source !== editor.scrollDOM) return;
      queueSync(source, previewScroller, () => {
        previewScroller.scrollTop = mappedScrollOffset(
          currentScrollMap(),
          source.scrollTop,
          "source",
          "preview",
        );
      });
    };
    const synchronizeFromPreview = (): void => {
      const source = editor.scrollDOM;
      queueSync(previewScroller, source, () => {
        source.scrollTop = mappedScrollOffset(
          currentScrollMap(),
          previewScroller.scrollTop,
          "preview",
          "source",
        );
      });
    };

    const mutationObserver = new MutationObserver(invalidateScrollMap);
    mutationObserver.observe(preview, { childList: true, subtree: true });
    const resizeObserver = new ResizeObserver(invalidateScrollMap);
    // CodeMirror refines estimated offscreen and wrapped-line heights as they enter
    // the viewport. The map must follow the content box, not only the fixed scroller.
    resizeObserver.observe(editor.contentDOM);
    resizeObserver.observe(editor.scrollDOM);
    resizeObserver.observe(preview);
    resizeObserver.observe(previewScroller);
    editorHost.addEventListener("scroll", synchronizeFromSource, true);
    previewScroller.addEventListener("scroll", synchronizeFromPreview);
    return () => {
      mutationObserver.disconnect();
      resizeObserver.disconnect();
      editorHost.removeEventListener("scroll", synchronizeFromSource, true);
      previewScroller.removeEventListener("scroll", synchronizeFromPreview);
      if (syncFrame !== undefined) cancelAnimationFrame(syncFrame);
    };
  }, [editor, editorHostRef, previewRef, previewScrollerRef]);
}

function collectScrollMap(
  editor: EditorView,
  preview: HTMLElement,
  previewScroller: HTMLElement,
): readonly ScrollMapPoint[] {
  const sourceMaximum = Math.max(0, editor.scrollDOM.scrollHeight - editor.scrollDOM.clientHeight);
  const previewMaximum = Math.max(0, previewScroller.scrollHeight - previewScroller.clientHeight);
  if (sourceMaximum === 0 || previewMaximum === 0) return [{ preview: 0, source: 0 }];

  const sourceAnchor = editor.defaultLineHeight * synchronizationLineOffset;
  const previewAnchor =
    measuredLineHeight(preview, editor.defaultLineHeight) * synchronizationLineOffset;
  const segments = collectPreviewSourceSegments(preview, previewScroller);
  const candidates: ScrollMapPoint[] = [];

  // Each point describes the moment a sampled visual source line reaches the
  // three-line anchor. The next sample is three visual rows farther down, at about
  // six rows from the viewport top, so interpolation also accounts for wrapped
  // Markdown lines instead of drifting according to logical line numbers.
  for (
    let documentHeight = sourceAnchor;
    documentHeight <= editor.contentHeight;
    documentHeight += sourceAnchor
  ) {
    const position = editorPositionAtDocumentHeight(editor, documentHeight);
    candidates.push({
      preview:
        previewPositionForSource(
          position,
          segments,
          editor.state.doc.length,
          previewScroller.scrollHeight,
        ) - previewAnchor,
      source: documentHeight - sourceAnchor,
    });
  }

  const points: ScrollMapPoint[] = [{ preview: 0, source: 0 }];
  for (const candidate of candidates.toSorted((left, right) => left.source - right.source)) {
    const previous = points.at(-1);
    if (
      previous === undefined ||
      candidate.source <= previous.source ||
      candidate.preview <= previous.preview ||
      candidate.source >= sourceMaximum ||
      candidate.preview >= previewMaximum
    ) {
      continue;
    }
    points.push(candidate);
  }
  points.push({ preview: previewMaximum, source: sourceMaximum });
  return points;
}

function collectPreviewSourceSegments(
  preview: HTMLElement,
  scroller: HTMLElement,
): readonly PreviewSourceSegment[] {
  const scrollerRectangle = scroller.getBoundingClientRect();
  return [
    ...preview.querySelectorAll<HTMLElement>(
      "[data-inkling-source-start][data-inkling-source-end]",
    ),
  ].flatMap((element) => {
    const start = Number(element.dataset["inklingSourceStart"]);
    const end = Number(element.dataset["inklingSourceEnd"]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start) {
      return [];
    }
    const rectangle = element.getBoundingClientRect();
    const top = rectangle.top - scrollerRectangle.top + scroller.scrollTop;
    const bottom = rectangle.bottom - scrollerRectangle.top + scroller.scrollTop;
    return bottom <= top ? [] : [{ bottom, element, end, start, top }];
  });
}

function previewPositionForSource(
  position: number,
  segments: readonly PreviewSourceSegment[],
  sourceLength: number,
  previewHeight: number,
): number {
  const containing = segments
    .filter((segment) => segment.start <= position && segment.end >= position)
    .toSorted(compareSourceSpecificity)[0];
  if (containing !== undefined) {
    return interpolate(
      containing.top,
      containing.bottom,
      (position - containing.start) / (containing.end - containing.start),
    );
  }
  const before = segments
    .filter((segment) => segment.end < position)
    .toSorted((left, right) => right.end - left.end || right.bottom - left.bottom)[0];
  const after = segments
    .filter((segment) => segment.start > position)
    .toSorted((left, right) => left.start - right.start || left.top - right.top)[0];
  return interpolateBetweenSourcePoints(
    position,
    before?.end ?? 0,
    before?.bottom ?? 0,
    after?.start ?? sourceLength,
    after?.top ?? previewHeight,
  );
}

function compareSourceSpecificity(left: PreviewSourceSegment, right: PreviewSourceSegment): number {
  const sourceLength = left.end - left.start - (right.end - right.start);
  if (sourceLength !== 0) return sourceLength;
  const verticalLength = left.bottom - left.top - (right.bottom - right.top);
  if (verticalLength !== 0) return verticalLength;
  return left.element.querySelectorAll("*").length - right.element.querySelectorAll("*").length;
}

function mappedScrollOffset(
  points: readonly ScrollMapPoint[],
  position: number,
  from: keyof ScrollMapPoint,
  to: keyof ScrollMapPoint,
): number {
  if (points.length < 2 || position <= 0) return 0;
  let low = 1;
  let high = points.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((points[middle]?.[from] ?? 0) < position) low = middle + 1;
    else high = middle;
  }
  const before = points[low - 1];
  const after = points[low];
  if (before === undefined || after === undefined) return 0;
  return interpolateBetweenSourcePoints(position, before[from], before[to], after[from], after[to]);
}

function interpolateBetweenSourcePoints(
  position: number,
  beforePosition: number,
  beforeValue: number,
  afterPosition: number,
  afterValue: number,
): number {
  if (afterPosition <= beforePosition) return beforeValue;
  return interpolate(
    beforeValue,
    afterValue,
    (position - beforePosition) / (afterPosition - beforePosition),
  );
}

function interpolate(start: number, end: number, progress: number): number {
  return start + (end - start) * Math.max(0, Math.min(1, progress));
}

function editorPositionAtDocumentHeight(editor: EditorView, documentHeight: number): number {
  const block = editor.lineBlockAtHeight(
    Math.max(0, Math.min(editor.contentHeight, documentHeight)),
  );
  const progress = block.height === 0 ? 0 : (documentHeight - block.top) / block.height;
  return Math.round(interpolate(block.from, block.to, progress));
}

function measuredLineHeight(element: HTMLElement, fallback: number): number {
  const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight);
  return Number.isFinite(lineHeight) && lineHeight > 0 ? lineHeight : fallback;
}

export function connectionLabel(state: ConnectionState): string {
  const labels: Record<ConnectionState, string> = {
    connecting: "Connecting",
    disconnected: "Offline — edits unsaved",
    ready: "Saved",
    saving: "Saving…",
  };
  return labels[state];
}
