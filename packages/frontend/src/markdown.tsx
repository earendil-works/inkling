import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { Mermaid } from "mermaid";
import { Effect } from "effect";

import { makeMarkdownRenderer } from "@earendil-works/inkling-renderer";
import type {
  DocumentFrontmatter,
  DocumentReference,
  ReferenceResolution,
  ReferenceResolutions,
  RenderHeading,
} from "@earendil-works/inkling-renderer";

import type { ApiClientService } from "./api.ts";
import {
  mountMermaidDiagramControls,
  mountMermaidDiagramError,
} from "./components/mermaid-diagram-controls.ts";
import { useEffectQuery } from "./effect-hooks.ts";
import { browserRuntime } from "./effect-runtime.ts";

const renderer = makeMarkdownRenderer();
const emptyHeadings: readonly RenderHeading[] = [];
const emptyReferences: readonly DocumentReference[] = [];
let mermaidPromise: Promise<Mermaid> | undefined;
let diagramGeneration = 0;

export interface RenderedMarkdown {
  readonly html: string;
  readonly error: string | undefined;
  readonly frontmatter: DocumentFrontmatter | undefined;
  readonly headings: readonly RenderHeading[];
  readonly loading: boolean;
  /** References to other documents, which the caller resolves. */
  readonly references: readonly DocumentReference[];
  readonly title: string | undefined;
}

/** How a document renders beyond its source. */
export interface MarkdownRenderSettings {
  /** RFCs number their sections. */
  readonly numberHeadings?: boolean | undefined;
  readonly references?: ReferenceResolutions | undefined;
}

export type MarkdownRenderResult = Effect.Effect.Success<ReturnType<typeof renderer.render>>;

/**
 * Markdown the server already rendered, by render key. Rendering loads code
 * languages asynchronously, so server rendering resolves it up front.
 */
export const PrerenderedMarkdownContext = createContext<
  ReadonlyMap<string, MarkdownRenderResult> | undefined
>(undefined);

/** Identifies one rendering of a source without repeating the source. */
export function markdownRenderKey(
  source: string,
  sourcePositions: boolean,
  settings: MarkdownRenderSettings = {},
): string {
  const input = `${settingsFingerprint(settings)}\u0000${source}`;
  let hash = 0x811c_9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x0100_0193) >>> 0;
  }
  return `${sourcePositions ? "positioned" : "plain"}:${source.length}:${hash.toString(36)}`;
}

function settingsFingerprint(settings: MarkdownRenderSettings): string {
  const references = [...(settings.references ?? new Map<string, ReferenceResolution>())]
    .map(([key, resolution]) =>
      resolution.status === "available"
        ? [
            key,
            resolution.href,
            resolution.rfcNumber ?? null,
            resolution.title,
            resolution.section?.id ?? null,
            resolution.section?.number ?? null,
            resolution.section?.text ?? null,
          ]
        : [key],
    )
    .toSorted((left, right) => compareStrings(String(left[0]), String(right[0])));
  return JSON.stringify([settings.numberHeadings === true, references]);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Renders Markdown exactly as `useRenderedMarkdown` does. */
export function renderMarkdown(
  source: string,
  sourcePositions: boolean,
  settings: MarkdownRenderSettings = {},
): ReturnType<typeof renderer.render> {
  return renderer.render(source, {
    numberHeadings: settings.numberHeadings,
    references: settings.references,
    sourcePositions,
  });
}

export function useRenderedMarkdown(
  source: string,
  sourcePositions: boolean,
  settings: MarkdownRenderSettings = {},
): RenderedMarkdown {
  // Settings often arrive as new objects with the same content; the
  // fingerprint keeps rendering from repeating for them.
  const fingerprint = settingsFingerprint(settings);
  const stableSettings = useMemo(() => settings, [fingerprint]);
  const query = useMemo(
    () => renderMarkdown(source, sourcePositions, stableSettings),
    [source, sourcePositions, stableSettings],
  );
  const key = useMemo(
    () => markdownRenderKey(source, sourcePositions, stableSettings),
    [source, sourcePositions, stableSettings],
  );
  const prerendered = useContext(PrerenderedMarkdownContext)?.get(key);
  const { state } = useEffectQuery(
    query,
    key,
    prerendered === undefined ? undefined : { data: prerendered, key },
  );
  return {
    error: state.status === "failure" ? state.error.message : undefined,
    frontmatter: state.data?.frontmatter,
    headings: state.data?.headings ?? emptyHeadings,
    html: state.data?.html ?? "",
    loading: state.status === "loading",
    references: state.data?.references ?? emptyReferences,
    title: state.data?.title,
  };
}

/** Resolutions keyed by reference, as the API and route data carry them. */
export type ReferenceResolutionRecord = Readonly<Record<string, ReferenceResolution>>;

/** How the reader first renders a document: RFCs number their sections. */
export function documentRenderSettings(
  metadata: { readonly rfcNumber?: number | undefined },
  references: ReferenceResolutionRecord | undefined,
): MarkdownRenderSettings {
  return {
    numberHeadings: metadata.rfcNumber !== undefined,
    references: new Map(Object.entries(references ?? {})),
  };
}

const referenceRequestDelayMilliseconds = 300;

/**
 * Renders a document with its references resolved for the current reader.
 * It starts from the resolutions the route loaded and asks for references
 * added since, such as ones an author just typed.
 */
export function useDocumentMarkdown(
  api: ApiClientService | undefined,
  source: string,
  metadata: { readonly rfcNumber?: number | undefined },
  initialReferences: ReferenceResolutionRecord | undefined,
): RenderedMarkdown {
  const [resolutions, setResolutions] = useState<ReferenceResolutions>(
    () => new Map(Object.entries(initialReferences ?? {})),
  );
  const requested = useRef(new Set<string>(Object.keys(initialReferences ?? {})));
  // A route that loads again, or another document, brings fresh resolutions.
  const [seed, setSeed] = useState(initialReferences);
  if (seed !== initialReferences) {
    setSeed(initialReferences);
    setResolutions((current) => new Map([...current, ...Object.entries(initialReferences ?? {})]));
  }
  const rendered = useRenderedMarkdown(source, true, {
    numberHeadings: metadata.rfcNumber !== undefined,
    references: resolutions,
  });
  const missingKey = [
    ...new Set(
      rendered.references
        .map((reference) => reference.key)
        .filter((key) => !resolutions.has(key) && !requested.current.has(key)),
    ),
  ]
    .toSorted(compareStrings)
    .join("\n");

  useEffect(() => {
    if (api === undefined || missingKey === "") return;
    const keys = missingKey.split("\n");
    const timer = setTimeout(() => {
      for (const key of keys) requested.current.add(key);
      browserRuntime.runFork(
        api.resolveReferences(keys).pipe(
          Effect.tap((response) =>
            Effect.sync(() =>
              setResolutions((current) => {
                const next = new Map(current);
                for (const [key, resolution] of Object.entries(response.references)) {
                  next.set(key, resolution);
                }
                return next;
              }),
            ),
          ),
          // Unresolved references stay pending; a later render asks again.
          Effect.tapError(() =>
            Effect.sync(() => {
              for (const key of keys) requested.current.delete(key);
            }),
          ),
          Effect.ignore,
        ),
      );
    }, referenceRequestDelayMilliseconds);
    return () => clearTimeout(timer);
  }, [api, missingKey]);

  return rendered;
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
    const update = (): void => setRevision((current) => current + 1);
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, {
      attributeFilter: ["data-color-scheme"],
      attributes: true,
    });
    const systemScheme = matchMedia("(prefers-color-scheme: dark)");
    systemScheme.addEventListener("change", update);
    return () => {
      observer.disconnect();
      systemScheme.removeEventListener("change", update);
    };
  }, []);
  return revision;
}

function loadMermaid(): Promise<Mermaid> {
  // Diagrams render in the browser; keep Mermaid out of the server renderer.
  if (import.meta.env.SSR) return Promise.reject(new Error("Mermaid renders in the browser."));
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
    fontFamily: style.getPropertyValue("--semantic-font-family-ui").trim(),
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
