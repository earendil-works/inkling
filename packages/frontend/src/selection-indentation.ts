import { indentLess, indentMore } from "@codemirror/commands";
import { keymap } from "@codemirror/view";
import type { Command } from "@codemirror/view";

const withActiveSelection =
  (command: Command): Command =>
  (view) =>
    view.state.selection.ranges.some((range) => !range.empty) && command(view);

export const selectionIndentationExtension = keymap.of([
  { key: "Tab", run: withActiveSelection(indentMore) },
  { key: "Shift-Tab", run: withActiveSelection(indentLess) },
]);
