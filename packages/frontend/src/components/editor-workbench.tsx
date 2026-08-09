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
          <span>Markdown + frontmatter</span>
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

    let syncFrame: number | undefined;
    let releaseFrame: number | undefined;
    let programmaticTarget: HTMLElement | undefined;

    const queueSync = (source: HTMLElement, target: HTMLElement, synchronize: () => void): void => {
      if (programmaticTarget === source) return;
      if (syncFrame !== undefined) cancelAnimationFrame(syncFrame);
      syncFrame = requestAnimationFrame(() => {
        syncFrame = undefined;
        programmaticTarget = target;
        synchronize();
        if (releaseFrame !== undefined) cancelAnimationFrame(releaseFrame);
        releaseFrame = requestAnimationFrame(() => {
          releaseFrame = undefined;
          if (programmaticTarget === target) programmaticTarget = undefined;
        });
      });
    };

    const synchronizeFromSource = (event: Event): void => {
      const source = event.target;
      if (!(source instanceof HTMLElement) || source !== editor.scrollDOM) return;
      queueSync(source, previewScroller, () => {
        const sourceRectangle = source.getBoundingClientRect();
        const sourceAnchor = sourceRectangle.top + source.clientHeight / 2;
        const sourcePosition = editor.posAtCoords(
          { x: editor.contentDOM.getBoundingClientRect().left + 1, y: sourceAnchor },
          false,
        );
        const previewPosition = previewPositionForSource(
          sourcePosition,
          collectPreviewSourceSegments(preview, previewScroller),
          editor.state.doc.length,
          previewScroller.scrollHeight,
        );
        previewScroller.scrollTop = previewPosition - previewScroller.clientHeight / 2;
      });
    };
    const synchronizeFromPreview = (): void => {
      const source = editor.scrollDOM;
      queueSync(previewScroller, source, () => {
        const previewPosition = previewScroller.scrollTop + previewScroller.clientHeight / 2;
        const sourcePosition = sourcePositionForPreview(
          previewPosition,
          collectPreviewSourceSegments(preview, previewScroller),
          editor.state.doc.length,
          previewScroller.scrollHeight,
        );
        const sourceRectangle = source.getBoundingClientRect();
        const sourceAnchor = sourceRectangle.top + source.clientHeight / 2;
        const currentDocumentPosition = sourceAnchor - editor.documentTop;
        const targetDocumentPosition = editorDocumentPosition(editor, sourcePosition);
        source.scrollTop += targetDocumentPosition - currentDocumentPosition;
      });
    };

    editorHost.addEventListener("scroll", synchronizeFromSource, true);
    previewScroller.addEventListener("scroll", synchronizeFromPreview);
    return () => {
      editorHost.removeEventListener("scroll", synchronizeFromSource, true);
      previewScroller.removeEventListener("scroll", synchronizeFromPreview);
      if (syncFrame !== undefined) cancelAnimationFrame(syncFrame);
      if (releaseFrame !== undefined) cancelAnimationFrame(releaseFrame);
    };
  }, [editor, editorHostRef, previewRef, previewScrollerRef]);
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

function sourcePositionForPreview(
  position: number,
  segments: readonly PreviewSourceSegment[],
  sourceLength: number,
  previewHeight: number,
): number {
  const containing = segments
    .filter((segment) => segment.top <= position && segment.bottom >= position)
    .toSorted(compareSourceSpecificity)[0];
  if (containing !== undefined) {
    return interpolate(
      containing.start,
      containing.end,
      (position - containing.top) / (containing.bottom - containing.top),
    );
  }
  const before = segments
    .filter((segment) => segment.bottom < position)
    .toSorted((left, right) => right.bottom - left.bottom || right.end - left.end)[0];
  const after = segments
    .filter((segment) => segment.top > position)
    .toSorted((left, right) => left.top - right.top || left.start - right.start)[0];
  return interpolateBetweenSourcePoints(
    position,
    before?.bottom ?? 0,
    before?.end ?? 0,
    after?.top ?? previewHeight,
    after?.start ?? sourceLength,
  );
}

function compareSourceSpecificity(left: PreviewSourceSegment, right: PreviewSourceSegment): number {
  const sourceLength = left.end - left.start - (right.end - right.start);
  if (sourceLength !== 0) return sourceLength;
  const verticalLength = left.bottom - left.top - (right.bottom - right.top);
  if (verticalLength !== 0) return verticalLength;
  return left.element.querySelectorAll("*").length - right.element.querySelectorAll("*").length;
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

function editorDocumentPosition(editor: EditorView, position: number): number {
  const clamped = Math.max(0, Math.min(editor.state.doc.length, position));
  const line = editor.state.doc.lineAt(clamped);
  const block = editor.lineBlockAt(clamped);
  const progress = line.length === 0 ? 0 : (clamped - line.from) / line.length;
  return interpolate(block.top, block.top + block.height, progress);
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
