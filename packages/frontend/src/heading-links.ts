import { useCallback } from "react";
import { Effect } from "effect";

import { useAppContext } from "./app-context.tsx";
import { copyText } from "./clipboard.ts";
import { browserRuntime } from "./effect-runtime.ts";

/**
 * A click handler for rendered Markdown that copies a section's link when
 * its heading anchor is clicked, while the browser still jumps to the
 * section. The link uses the document's reader path, so links copied in the
 * editor or through a share link stay canonical, and pasting one into a
 * document turns it into a reference.
 */
export function useHeadingLinkCopying(
  documentPath: string,
): (event: React.MouseEvent<HTMLElement>) => void {
  const { showToast } = useAppContext();
  return useCallback(
    (event: React.MouseEvent<HTMLElement>) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }
      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest<HTMLAnchorElement>("a.inkling-heading-anchor");
      if (anchor === null || !event.currentTarget.contains(anchor)) return;
      const url = new URL(`${documentPath}${anchor.getAttribute("href") ?? ""}`, location.origin);
      browserRuntime.runFork(
        copyText(url.href).pipe(
          Effect.match({
            onFailure: (error) => showToast(error.message, "error"),
            onSuccess: () => showToast("Copied a link to this section.", "success"),
          }),
        ),
      );
    },
    [documentPath, showToast],
  );
}
