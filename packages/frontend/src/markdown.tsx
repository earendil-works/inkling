import { useMemo } from "react";
import type { Mermaid } from "mermaid";
import { Effect } from "effect";

import { makeMarkdownRenderer } from "@earendil-works/jot-renderer";

import { mountMermaidDiagramControls } from "./components/mermaid-diagram-controls.ts";
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
          mountMermaidDiagramControls(diagram, rendered.svg);
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
