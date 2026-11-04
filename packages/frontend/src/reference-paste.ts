import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { parseReference } from "@earendil-works/inkling-renderer";

export interface PasteTargetDocument {
  readonly documentId: string;
  readonly rfcNumber?: number | undefined;
}

export interface PastedReference {
  /** The link destination: `rfc:57#motivation`, `doc:…`, or `#motivation`. */
  readonly destination: string;
  /** Whether the destination is a section of the document being edited. */
  readonly self: boolean;
}

/**
 * The reference a pasted link to a document of this workspace stands for.
 * Links to RFCs and notes, including editor and public URLs and a section
 * fragment, become references; share links and other URLs stay links.
 */
export function referenceForPastedUrl(
  text: string,
  origin: string,
  current: PasteTargetDocument,
): PastedReference | undefined {
  const trimmed = text.trim();
  if (trimmed === "" || /\s/u.test(trimmed)) return undefined;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return undefined;
  }
  if (url.origin !== origin) return undefined;
  const rfc = /^\/rfcs?\/(\d+)(?:\/edit)?\/?$/u.exec(url.pathname);
  const note = /^\/(?:documents|public\/documents)\/([^/]+)(?:\/edit)?\/?$/u.exec(url.pathname);
  const base =
    rfc?.[1] === undefined
      ? note?.[1] === undefined
        ? undefined
        : `doc:${safeDecode(note[1])}`
      : `rfc:${Number(rfc[1])}`;
  if (base === undefined) return undefined;
  const fragment = url.hash.slice(1);
  const reference = parseReference(fragment === "" ? base : `${base}#${fragment}`);
  if (reference === undefined) return undefined;
  const self =
    reference.target.kind === "rfc"
      ? reference.target.rfcNumber === current.rfcNumber
      : reference.target.documentId === current.documentId;
  if (self && reference.anchor !== undefined) {
    return {
      destination: `#${encodeURIComponent(reference.anchor)}`,
      self: true,
    };
  }
  return { destination: reference.key, self: false };
}

/** The Markdown a pasted reference becomes at the editor's selection. */
export function pastedReferenceMarkdown(
  reference: PastedReference,
  selectedText: string,
  textBefore: string,
): string {
  // Pasted as the destination of a link being written: `[text](` + link.
  if (selectedText === "" && textBefore.endsWith("](")) return reference.destination;
  if (selectedText !== "") return `[${selectedText}](${reference.destination})`;
  return reference.self ? `[](${reference.destination})` : `<${reference.destination}>`;
}

/**
 * Turns pasted links to documents of this workspace into references, so
 * they show the target's current title and section number.
 */
export function referencePasteExtension(current: () => PasteTargetDocument): Extension {
  return EditorView.domEventHandlers({
    paste(event, view) {
      if (!view.state.facet(EditorView.editable) || view.state.selection.ranges.length !== 1) {
        return false;
      }
      const text = event.clipboardData?.getData("text/plain");
      if (text === undefined) return false;
      const reference = referenceForPastedUrl(text, location.origin, current());
      if (reference === undefined) return false;
      const range = view.state.selection.main;
      const insert = pastedReferenceMarkdown(
        reference,
        view.state.sliceDoc(range.from, range.to),
        view.state.sliceDoc(Math.max(0, range.from - 2), range.from),
      );
      event.preventDefault();
      view.dispatch({
        changes: { from: range.from, insert, to: range.to },
        scrollIntoView: true,
        selection: { anchor: range.from + insert.length },
        userEvent: "input.paste",
      });
      return true;
    },
  });
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
