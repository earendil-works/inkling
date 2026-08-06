import { useMemo } from "react";
import type { Mermaid } from "mermaid";
import { Effect } from "effect";

import { makeMarkdownRenderer } from "@earendil-works/jot-renderer";

import { useEffectQuery } from "./effect-hooks.ts";

const renderer = makeMarkdownRenderer();
let mermaidPromise: Promise<Mermaid> | undefined;
let diagramGeneration = 0;

export interface RenderedMarkdown {
  readonly html: string;
  readonly error: string | undefined;
  readonly loading: boolean;
}

export function useRenderedMarkdown(source: string, sourcePositions: boolean): RenderedMarkdown {
  const query = useMemo(
    () => renderer.render(source, { sourcePositions }),
    [source, sourcePositions],
  );
  const { state } = useEffectQuery(query, `${sourcePositions ? "positioned" : "plain"}:${source}`);
  return {
    error: state.status === "failure" ? state.error.message : undefined,
    html: state.data?.html ?? "",
    loading: state.status === "loading",
  };
}

export function renderMermaid(root: ParentNode): Effect.Effect<void> {
  const diagrams = [...root.querySelectorAll<HTMLElement>("[data-mermaid]")];
  if (diagrams.length === 0) return Effect.void;
  return Effect.tryPromise({
    catch: () => undefined,
    try: async () => {
      const mermaid = await loadMermaid();
      await Promise.all(
        diagrams.map(async (diagram) => {
          const code = diagram.querySelector("code")?.textContent ?? "";
          const rendered = await mermaid.render(`jot-mermaid-${++diagramGeneration}`, code);
          if (!diagram.isConnected) return;
          diagram.innerHTML = `<div class="mermaid-viewport">${rendered.svg}</div><div class="jot-mermaid__controls"><button type="button" data-mermaid-zoom-in aria-label="Zoom in">+</button><button type="button" data-mermaid-zoom-out aria-label="Zoom out">−</button><button type="button" data-mermaid-reset>Reset</button></div>`;
          bindMermaidControls(diagram);
        }),
      );
    },
  }).pipe(Effect.ignore);
}

function loadMermaid(): Promise<Mermaid> {
  mermaidPromise ??= import("mermaid").then(({ default: mermaid }) => {
    mermaid.initialize({
      securityLevel: "strict",
      startOnLoad: false,
      theme: document.documentElement.dataset["theme"] === "dark" ? "dark" : "neutral",
    });
    return mermaid;
  });
  return mermaidPromise;
}

function bindMermaidControls(diagram: HTMLElement): void {
  const viewport = diagram.querySelector<HTMLElement>(".mermaid-viewport");
  if (viewport === null) return;
  let scale = 1;
  let offsetX = 0;
  let offsetY = 0;
  let dragStart: { readonly x: number; readonly y: number } | undefined;
  const applyTransform = (): void => {
    viewport.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(${scale})`;
  };
  diagram.querySelector("[data-mermaid-zoom-in]")?.addEventListener("click", () => {
    scale = Math.min(4, scale + 0.2);
    applyTransform();
  });
  diagram.querySelector("[data-mermaid-zoom-out]")?.addEventListener("click", () => {
    scale = Math.max(0.4, scale - 0.2);
    applyTransform();
  });
  diagram.querySelector("[data-mermaid-reset]")?.addEventListener("click", () => {
    scale = 1;
    offsetX = 0;
    offsetY = 0;
    applyTransform();
  });
  viewport.addEventListener("pointerdown", (event) => {
    dragStart = { x: event.clientX - offsetX, y: event.clientY - offsetY };
    viewport.setPointerCapture(event.pointerId);
  });
  viewport.addEventListener("pointermove", (event) => {
    if (dragStart === undefined) return;
    offsetX = event.clientX - dragStart.x;
    offsetY = event.clientY - dragStart.y;
    applyTransform();
  });
  viewport.addEventListener("pointerup", (event) => {
    dragStart = undefined;
    viewport.releasePointerCapture(event.pointerId);
  });
}
