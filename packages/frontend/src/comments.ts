import { StateEffect, StateField } from "@codemirror/state";
import type { EditorState, Extension, Text } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";

import type { CommentThreadDto } from "@earendil-works/jot-protocol";

export interface ProjectedCommentThread {
  readonly end: number;
  readonly orphaned: boolean;
  readonly start: number;
  readonly thread: CommentThreadDto;
}

export interface PreviewSourceRange {
  readonly end: number;
  readonly start: number;
}

const replaceCommentDecorations = StateEffect.define<readonly ProjectedCommentThread[]>();
const setCommentComposerEnabled = StateEffect.define<boolean>();
const setCommentComposerRange = StateEffect.define<PreviewSourceRange | undefined>();

class CommentBubbleWidget extends WidgetType {
  readonly thread: CommentThreadDto;

  constructor(thread: CommentThreadDto) {
    super();
    this.thread = thread;
  }

  override eq(other: CommentBubbleWidget): boolean {
    return (
      other.thread.id === this.thread.id &&
      other.thread.messages.length === this.thread.messages.length &&
      other.thread.resolved === this.thread.resolved &&
      other.thread.updatedAt === this.thread.updatedAt
    );
  }

  toDOM(): HTMLElement {
    const anchor = document.createElement("span");
    anchor.className = "cm-comment-bubble-anchor";
    anchor.append(makeCommentBubble(this.thread, "source"));
    return anchor;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

class CommentComposerBubbleWidget extends WidgetType {
  readonly end: number;
  readonly start: number;

  constructor(start: number, end: number) {
    super();
    this.start = start;
    this.end = end;
  }

  override eq(other: CommentComposerBubbleWidget): boolean {
    return other.start === this.start && other.end === this.end;
  }

  toDOM(): HTMLElement {
    const anchor = document.createElement("span");
    anchor.className = "cm-comment-bubble-anchor";
    anchor.append(makeCommentComposerBubble(this.start, this.end, "source"));
    return anchor;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

const commentDecorationField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  provide: (field) => EditorView.decorations.from(field),
  update: (decorations, transaction) => {
    let next = decorations.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (!effect.is(replaceCommentDecorations)) continue;
      const ranges = effect.value.flatMap((projection) => {
        if (projection.orphaned) return [];
        const from = Math.max(0, Math.min(transaction.state.doc.length, projection.start));
        const to = Math.max(from, Math.min(transaction.state.doc.length, projection.end));
        const widgetPosition = trailingVisiblePosition(transaction.state.doc, from, to);
        const widget = Decoration.widget({
          // At a line boundary, stay before the newline so the bubble trails
          // the selected Markdown line instead of occupying the next one.
          side: -1,
          widget: new CommentBubbleWidget(projection.thread),
        }).range(widgetPosition);
        if (from === to) return [widget];
        const mark = Decoration.mark({
          attributes: {
            "data-comment-thread": projection.thread.id,
            title: `Comment by ${rootAuthor(projection.thread)}`,
          },
          class: "cm-comment-anchor",
        }).range(from, to);
        return [mark, widget];
      });
      next = Decoration.set(ranges, true);
    }
    return next;
  },
});

interface CommentComposerDecorationState {
  readonly decorations: DecorationSet;
  readonly enabled: boolean;
  readonly range: PreviewSourceRange | undefined;
}

const commentComposerDecorationField = StateField.define<CommentComposerDecorationState>({
  create: () => ({ decorations: Decoration.none, enabled: false, range: undefined }),
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
  update: (value, transaction) => {
    let enabled = value.enabled;
    let range =
      value.range === undefined
        ? undefined
        : {
            end: transaction.changes.mapPos(value.range.end, -1),
            start: transaction.changes.mapPos(value.range.start, 1),
          };
    for (const effect of transaction.effects) {
      if (effect.is(setCommentComposerEnabled)) enabled = effect.value;
      if (effect.is(setCommentComposerRange)) range = effect.value;
    }
    const selection = transaction.state.selection.main;
    if (
      !enabled ||
      selection.empty ||
      range === undefined ||
      range.start !== selection.from ||
      range.end !== selection.to
    ) {
      range = undefined;
    }
    return {
      decorations: selectionComposerDecorations(transaction.state, range),
      enabled,
      range,
    };
  },
});

export const commentDecorationsExtension: Extension = [
  commentDecorationField,
  commentComposerDecorationField,
];

function selectionComposerDecorations(
  state: EditorState,
  range: PreviewSourceRange | undefined,
): DecorationSet {
  if (range === undefined) return Decoration.none;
  const position = trailingVisiblePosition(state.doc, range.start, range.end);
  return Decoration.set([
    Decoration.widget({
      side: -1,
      widget: new CommentComposerBubbleWidget(range.start, range.end),
    }).range(position),
  ]);
}

function trailingVisiblePosition(document: Text, from: number, to: number): number {
  let position = to;
  while (position > from && /\s/u.test(document.sliceString(position - 1, position))) {
    position -= 1;
  }
  return position;
}

export function updateEditorCommentDecorations(
  editor: EditorView,
  projections: readonly ProjectedCommentThread[],
  composerEnabled: boolean,
): void {
  editor.dispatch({
    effects: [
      replaceCommentDecorations.of(projections),
      setCommentComposerEnabled.of(composerEnabled),
    ],
  });
}

export function updateEditorCommentComposer(
  editor: EditorView,
  range: PreviewSourceRange | undefined,
): void {
  editor.dispatch({ effects: setCommentComposerRange.of(range) });
}

export function renderPreviewCommentBubbles(
  preview: HTMLElement,
  projections: readonly ProjectedCommentThread[],
): void {
  clearPreviewCommentSlots(preview);
  const slots = new Map<HTMLElement, HTMLElement>();
  for (const projection of projections) {
    if (projection.orphaned) continue;
    const segment = findSourceSegment(preview, projection.start, projection.end);
    if (segment === undefined) continue;
    segment.classList.add("has-comment-anchor");
    const target = attachmentTarget(segment);
    let slot = slots.get(target);
    if (slot === undefined) {
      slot = makeCommentSlot(target);
      slots.set(target, slot);
    }
    slot.append(makeCommentBubble(projection.thread, "preview"));
  }
}

export function selectedPreviewSourceRange(preview: HTMLElement): PreviewSourceRange | undefined {
  const selection = document.getSelection();
  if (selection === null || selection.isCollapsed || selection.rangeCount === 0) return undefined;
  const range = selection.getRangeAt(0);
  if (!preview.contains(range.startContainer) || !preview.contains(range.endContainer)) {
    return undefined;
  }

  const startSegments = sourceAncestors(range.startContainer, preview);
  const endSegments = new Set(sourceAncestors(range.endContainer, preview));
  const shared = startSegments.find((element) => endSegments.has(element));
  if (shared !== undefined) return sourceRange(shared);

  const intersecting = sourceElements(preview)
    .filter((element) => range.intersectsNode(element))
    .map(sourceRange)
    .filter((value): value is PreviewSourceRange => value !== undefined);
  if (intersecting.length === 0) return undefined;
  return {
    end: Math.max(...intersecting.map((item) => item.end)),
    start: Math.min(...intersecting.map((item) => item.start)),
  };
}

export function renderPreviewCommentComposer(
  preview: HTMLElement,
  source: PreviewSourceRange | undefined,
): void {
  for (const composer of preview.querySelectorAll<HTMLElement>("[data-comment-composer]")) {
    const slot = composer.closest<HTMLElement>("[data-comment-slot]");
    composer.remove();
    if (slot?.childElementCount === 0) slot.remove();
  }
  if (source === undefined) return;
  const segment = findSourceSegment(preview, source.start, source.end);
  if (segment === undefined) return;
  const target = attachmentTarget(segment);
  const slot = existingCommentSlot(target) ?? makeCommentSlot(target);
  slot.append(makeCommentComposerBubble(source.start, source.end, "preview"));
}

function makeCommentComposerBubble(
  start: number,
  end: number,
  surface: "preview" | "source",
): HTMLElement {
  const button = document.createElement("button");
  button.className = "segment-comment-bubble comment-composer-bubble";
  button.dataset["commentComposer"] = "";
  button.dataset["commentSurface"] = surface;
  button.dataset["sourceEnd"] = String(end);
  button.dataset["sourceStart"] = String(start);
  button.type = "button";
  button.setAttribute("aria-label", "Comment on selection");
  button.title = "Comment on selection";

  const avatar = document.createElement("span");
  avatar.className = "segment-comment-bubble__avatar";
  avatar.textContent = "+";
  const label = document.createElement("span");
  label.className = "segment-comment-bubble__count";
  label.textContent = "New";
  button.append(avatar, label);
  return button;
}

function makeCommentBubble(thread: CommentThreadDto, surface: "preview" | "source"): HTMLElement {
  const button = document.createElement("button");
  button.className = "segment-comment-bubble";
  button.dataset["commentBubble"] = thread.id;
  button.dataset["commentSurface"] = surface;
  button.type = "button";
  button.setAttribute(
    "aria-label",
    `Open comment by ${rootAuthor(thread)}, ${thread.messages.length} ${thread.messages.length === 1 ? "message" : "messages"}`,
  );
  button.title = thread.messages[0]?.body ?? "Open comment thread";

  const avatar = document.createElement("span");
  avatar.className = "segment-comment-bubble__avatar";
  avatar.textContent = initials(rootAuthor(thread));
  const count = document.createElement("span");
  count.className = "segment-comment-bubble__count";
  count.textContent = String(thread.messages.length);
  button.append(avatar, count);
  return button;
}

function makeCommentSlot(target: HTMLElement): HTMLElement {
  const slot = document.createElement("span");
  slot.className = "segment-comment-slot";
  slot.dataset["commentSlot"] = "";
  slot.setAttribute("aria-label", "Comments attached to this text");
  target.append(slot);
  return slot;
}

function existingCommentSlot(target: HTMLElement): HTMLElement | undefined {
  const candidate = target.lastElementChild;
  return candidate instanceof HTMLElement && candidate.matches("[data-comment-slot]")
    ? candidate
    : undefined;
}

function clearPreviewCommentSlots(preview: HTMLElement): void {
  for (const slot of preview.querySelectorAll("[data-comment-slot]")) slot.remove();
  for (const segment of preview.querySelectorAll(".has-comment-anchor")) {
    segment.classList.remove("has-comment-anchor");
  }
}

function findSourceSegment(
  preview: HTMLElement,
  start: number,
  end: number,
): HTMLElement | undefined {
  const elements = sourceElements(preview);
  const containing = elements.filter((element) => {
    const source = sourceRange(element);
    return source !== undefined && source.start <= start && source.end >= end;
  });
  const candidates =
    containing.length > 0
      ? containing
      : elements.filter((element) => {
          const source = sourceRange(element);
          return source !== undefined && source.start < end && source.end > start;
        });
  return candidates.toSorted(compareSourceSegments)[0];
}

function compareSourceSegments(left: HTMLElement, right: HTMLElement): number {
  const leftRange = sourceRange(left);
  const rightRange = sourceRange(right);
  if (leftRange === undefined || rightRange === undefined) return 0;
  const lengthDifference = leftRange.end - leftRange.start - (rightRange.end - rightRange.start);
  if (lengthDifference !== 0) return lengthDifference;
  const priorityDifference = segmentPriority(left) - segmentPriority(right);
  if (priorityDifference !== 0) return priorityDifference;
  return right.querySelectorAll("*").length - left.querySelectorAll("*").length;
}

function segmentPriority(element: HTMLElement): number {
  const priorities: Readonly<Record<string, number>> = {
    fence: 1,
    heading: 1,
    paragraph: 1,
    tr: 2,
    list_item: 3,
    blockquote: 4,
    bullet_list: 5,
    ordered_list: 5,
    table: 5,
  };
  return priorities[element.dataset["jotSourceKind"] ?? ""] ?? 10;
}

function attachmentTarget(segment: HTMLElement): HTMLElement {
  if (segment.matches("p, h1, h2, h3, h4, h5, h6, li, td, th, pre")) return segment;
  const inlineDescendants = segment.querySelectorAll<HTMLElement>(
    "p, h1, h2, h3, h4, h5, h6, li, td, th, pre",
  );
  return inlineDescendants.item(inlineDescendants.length - 1) || segment;
}

function sourceElements(preview: HTMLElement): readonly HTMLElement[] {
  return [...preview.querySelectorAll<HTMLElement>("[data-jot-source-start][data-jot-source-end]")];
}

function sourceAncestors(node: Node, preview: HTMLElement): readonly HTMLElement[] {
  const ancestors: HTMLElement[] = [];
  let element = node instanceof HTMLElement ? node : node.parentElement;
  while (element !== null && preview.contains(element)) {
    if (sourceRange(element) !== undefined) ancestors.push(element);
    if (element === preview) break;
    element = element.parentElement;
  }
  return ancestors;
}

function sourceRange(element: HTMLElement): PreviewSourceRange | undefined {
  const start = Number(element.dataset["jotSourceStart"]);
  const end = Number(element.dataset["jotSourceEnd"]);
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && end >= start
    ? { end, start }
    : undefined;
}

function rootAuthor(thread: CommentThreadDto): string {
  return thread.messages[0]?.authorDisplayName || "Unknown author";
}

function initials(value: string): string {
  const words = value.trim().split(/\s+/u);
  const first = words[0]?.[0] ?? "?";
  const last = words.length > 1 ? (words.at(-1)?.[0] ?? "") : "";
  return `${first}${last}`.toLocaleUpperCase();
}
