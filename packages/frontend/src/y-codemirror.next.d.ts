declare module "y-codemirror.next" {
  import type { Extension } from "@codemirror/state";
  import type { Awareness } from "y-protocols/awareness";
  import type * as Y from "yjs";

  export function yCollab(
    text: Y.Text,
    awareness: Awareness,
    options?: { readonly undoManager?: Y.UndoManager | false },
  ): Extension;
}
