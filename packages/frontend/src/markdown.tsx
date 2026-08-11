import { useEffect, useMemo, useState } from "react";
import type { Mermaid } from "mermaid";
import { Effect } from "effect";

import { makeMarkdownRenderer } from "@earendil-works/inkling-renderer";
import type { DocumentFrontmatter, RenderHeading } from "@earendil-works/inkling-renderer";

import {
  mountMermaidDiagramControls,
  mountMermaidDiagramError,
} from "./components/mermaid-diagram-controls.ts";
import { useEffectQuery } from "./effect-hooks.ts";

const renderer = makeMarkdownRenderer();
const emptyHeadings: readonly RenderHeading[] = [];
let mermaidPromise: Promise<Mermaid> | undefined;
let diagramGeneration = 0;

export interface RenderedMarkdown {
  readonly html: string;
  readonly error: string | undefined;
  readonly frontmatter: DocumentFrontmatter | undefined;
  readonly headings: readonly RenderHeading[];
  readonly loading: boolean;
  readonly title: string | undefined;
}

export function useRenderedMarkdown(source: string, sourcePositions: boolean): RenderedMarkdown {
  const query = useMemo(
    () => renderer.render(source, { sourcePositions }),
    [source, sourcePositions],
  );
  const { state } = useEffectQuery(query, `${sourcePositions ? "positioned" : "plain"}:${source}`);
  return {
    error: state.status === "failure" ? state.error.message : undefined,
    frontmatter: state.data?.frontmatter,
    headings: state.data?.headings ?? emptyHeadings,
    html: state.data?.html ?? "",
    loading: state.status === "loading",
    title: state.data?.title,
  };
}

export function renderMermaid(root: ParentNode): Effect.Effect<void> {
  const diagrams = [...root.querySelectorAll<HTMLElement>("[data-mermaid]")];
  if (diagrams.length === 0) return Effect.void;
  return Effect.tryPromise({
    catch: () => undefined,
    try: async () => {
      const mermaid = await loadMermaid();
      mermaid.initialize({
        securityLevel: "strict",
        startOnLoad: false,
        suppressErrorRendering: true,
        theme: "base",
        themeVariables: mermaidThemeVariables(),
      });
      await Promise.all(diagrams.map((diagram) => renderMermaidDiagram(mermaid, diagram)));
    },
  }).pipe(Effect.ignore);
}

async function renderMermaidDiagram(mermaid: Mermaid, diagram: HTMLElement): Promise<void> {
  const code = diagram.querySelector("code")?.textContent ?? "";
  try {
    const parsed = await mermaid.parse(code, { suppressErrors: true });
    if (parsed === false) {
      if (diagram.isConnected) mountMermaidDiagramError(diagram);
      return;
    }
    const rendered = await mermaid.render(`inkling-mermaid-${++diagramGeneration}`, code);
    if (diagram.isConnected) mountMermaidDiagramControls(diagram, rendered.svg);
  } catch {
    if (diagram.isConnected) mountMermaidDiagramError(diagram);
  }
}

export function useThemeRevision(): number {
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const observer = new MutationObserver(() => setRevision((current) => current + 1));
    observer.observe(document.documentElement, {
      attributeFilter: ["data-theme"],
      attributes: true,
    });
    return () => observer.disconnect();
  }, []);
  return revision;
}

function loadMermaid(): Promise<Mermaid> {
  mermaidPromise ??= import("mermaid").then(({ default: mermaid }) => mermaid);
  return mermaidPromise;
}

function mermaidThemeVariables(): Record<string, string> {
  const style = getComputedStyle(document.documentElement);
  const value = (name: string): string => themeColorForMermaid(style.getPropertyValue(name).trim());
  const background = value("--mermaid-background");
  const text = value("--mermaid-primary-text");
  const border = value("--mermaid-primary-border");
  const line = value("--mermaid-line");
  return {
    activationBkgColor: value("--mermaid-secondary"),
    activationBorderColor: border,
    actorBkg: value("--mermaid-primary"),
    actorBorder: border,
    actorTextColor: text,
    background,
    clusterBkg: value("--mermaid-tertiary"),
    clusterBorder: border,
    edgeLabelBackground: background,
    fontFamily: style.getPropertyValue("--sans").trim(),
    labelBackground: background,
    labelBoxBkgColor: value("--mermaid-primary"),
    labelBoxBorderColor: border,
    labelTextColor: text,
    lineColor: line,
    loopTextColor: text,
    mainBkg: value("--mermaid-primary"),
    nodeBorder: border,
    noteBkgColor: value("--mermaid-note"),
    noteBorderColor: border,
    noteTextColor: value("--mermaid-note-text"),
    primaryBorderColor: border,
    primaryColor: value("--mermaid-primary"),
    primaryTextColor: text,
    secondaryColor: value("--mermaid-secondary"),
    signalColor: line,
    signalTextColor: text,
    tertiaryColor: value("--mermaid-tertiary"),
    textColor: text,
    titleColor: text,
  };
}

/** Mermaid's color arithmetic does not yet parse OKLCH, so resolve the themed color first. */
function themeColorForMermaid(color: string): string {
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext("2d");
  if (context === null) return color;
  context.fillStyle = color;
  context.fillRect(0, 0, 1, 1);
  const [red = 0, green = 0, blue = 0] = context.getImageData(0, 0, 1, 1).data;
  return `rgb(${red}, ${green}, ${blue})`;
}
