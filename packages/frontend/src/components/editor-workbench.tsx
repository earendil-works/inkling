import { useEffect, useRef } from "react";
import type { EditorView } from "codemirror";
import { Effect, Fiber } from "effect";

import type { DocumentMetadataDto } from "@earendil-works/inkling-protocol";
import type { RenderHeading } from "@earendil-works/inkling-renderer";

import type { ConnectionState } from "../collaboration.ts";
import { selectedPreviewSourceRange } from "../comments.ts";
import type { PreviewSourceRange } from "../comments.ts";
import { browserRuntime } from "../effect-runtime.ts";
import { renderMermaid } from "../markdown.tsx";
import { Button } from "./button.tsx";
import { DocumentPage } from "./document-page.tsx";

export interface EditorWorkbenchProps {
  readonly connectionState: ConnectionState;
  readonly editor: EditorView | undefined;
  readonly editorHostRef: React.RefObject<HTMLDivElement | null>;
  readonly onClosePreview: () => void;
  readonly onPreviewRendered: () => void;
  readonly onPreviewSelection: (range: PreviewSourceRange | undefined) => void;
  readonly previewHeadings: readonly RenderHeading[];
  readonly previewHtml: string;
  readonly previewRef: React.RefObject<HTMLElement | null>;
  readonly metadata: DocumentMetadataDto;
}

export function EditorWorkbench({
  connectionState,
  editor,
  editorHostRef,
  onClosePreview,
  onPreviewRendered,
  onPreviewSelection,
  previewHeadings,
  previewHtml,
  previewRef,
  metadata,
}: EditorWorkbenchProps): React.JSX.Element {
  const renderedCallbackRef = useRef(onPreviewRendered);
  const previewScrollerRef = useRef<HTMLDivElement>(null);
  renderedCallbackRef.current = onPreviewRendered;
  useSynchronizedScrolling(editor, editorHostRef, previewRef, previewScrollerRef);

  useEffect(() => {
    const preview = previewRef.current;
    if (preview === null) return;
    preview.innerHTML = previewHtml;
    if (previewHtml === "") {
      renderedCallbackRef.current();
      return;
    }
    const fiber = browserRuntime.runFork(
      renderMermaid(preview).pipe(
        Effect.ensuring(Effect.sync(() => renderedCallbackRef.current())),
      ),
    );
    return () => {
      browserRuntime.runFork(Fiber.interrupt(fiber));
    };
  }, [previewHtml, previewRef]);

  const capturePreviewSelection = (): void => {
    window.setTimeout(() => {
      const preview = previewRef.current;
      onPreviewSelection(preview === null ? undefined : selectedPreviewSourceRange(preview));
    });
  };

  return (
    <section className="workbench">
      <div className="source-pane" data-source-pane="">
        <div className="pane-label">
          <span>Markdown</span>
          <span data-save-state="">{connectionLabel(connectionState)}</span>
        </div>
        <div className="editor-host" data-editor="" ref={editorHostRef} />
      </div>
      <div className="preview-pane" data-preview-pane="">
        <div className="pane-label">
          <span>Preview</span>
          <Button
            aria-label="Close preview"
            variant="icon"
            data-preview-close=""
            onClick={onClosePreview}
          >
            ×
          </Button>
        </div>
        <div className="editor-preview-page" ref={previewScrollerRef}>
          <div className="editor-preview-page__paper">
            <DocumentPage headings={previewHeadings} metadata={metadata}>
              <article
                aria-label="Rendered document preview"
                className="markdown-body reader-body editor-preview-body"
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
