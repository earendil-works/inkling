import { useEffect, useRef } from "react";
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
  useSynchronizedScrolling(editorHostRef, previewScrollerRef);

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

function useSynchronizedScrolling(
  editorHostRef: React.RefObject<HTMLDivElement | null>,
  previewScrollerRef: React.RefObject<HTMLDivElement | null>,
): void {
  useEffect(() => {
    const editorHost = editorHostRef.current;
    const previewScroller = previewScrollerRef.current;
    if (editorHost === null || previewScroller === null) return;

    let syncFrame: number | undefined;
    let releaseFrame: number | undefined;
    let programmaticTarget: HTMLElement | undefined;

    const queueSync = (source: HTMLElement, target: HTMLElement): void => {
      if (programmaticTarget === source) return;
      if (syncFrame !== undefined) cancelAnimationFrame(syncFrame);
      syncFrame = requestAnimationFrame(() => {
        syncFrame = undefined;
        const sourceMaximum = source.scrollHeight - source.clientHeight;
        const targetMaximum = target.scrollHeight - target.clientHeight;
        if (sourceMaximum <= 0 || targetMaximum <= 0) return;
        programmaticTarget = target;
        target.scrollTop = (source.scrollTop / sourceMaximum) * targetMaximum;
        if (releaseFrame !== undefined) cancelAnimationFrame(releaseFrame);
        releaseFrame = requestAnimationFrame(() => {
          releaseFrame = undefined;
          if (programmaticTarget === target) programmaticTarget = undefined;
        });
      });
    };

    const synchronizeFromSource = (event: Event): void => {
      const source = event.target;
      if (!(source instanceof HTMLElement) || !source.matches(".cm-scroller")) return;
      queueSync(source, previewScroller);
    };
    const synchronizeFromPreview = (): void => {
      const source = editorHost.querySelector<HTMLElement>(".cm-scroller");
      if (source !== null) queueSync(previewScroller, source);
    };

    editorHost.addEventListener("scroll", synchronizeFromSource, true);
    previewScroller.addEventListener("scroll", synchronizeFromPreview);
    return () => {
      editorHost.removeEventListener("scroll", synchronizeFromSource, true);
      previewScroller.removeEventListener("scroll", synchronizeFromPreview);
      if (syncFrame !== undefined) cancelAnimationFrame(syncFrame);
      if (releaseFrame !== undefined) cancelAnimationFrame(releaseFrame);
    };
  }, [editorHostRef, previewScrollerRef]);
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
