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
  renderedCallbackRef.current = onPreviewRendered;

  useEffect(() => {
    const preview = previewRef.current;
    if (preview === null || previewHtml === "") return;
    preview.innerHTML = previewHtml;
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
        <div className="editor-preview-page">
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

export function connectionLabel(state: ConnectionState): string {
  const labels: Record<ConnectionState, string> = {
    connecting: "Connecting",
    disconnected: "Offline — edits unsaved",
    ready: "Saved",
    saving: "Saving…",
  };
  return labels[state];
}
