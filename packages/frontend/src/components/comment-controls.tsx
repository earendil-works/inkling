import { useImperativeHandle, useRef } from "react";

import type { ProjectedCommentThread } from "../comments.ts";
import { Button } from "./button.tsx";
import { CheckboxField } from "./checkbox-field.tsx";

export interface CommentControlsHandle {
  readonly close: () => void;
  readonly open: () => void;
}

export interface CommentControlsProps {
  readonly onShowResolvedChange: (show: boolean) => void;
  readonly orphaned: readonly ProjectedCommentThread[];
  readonly ref?: React.Ref<CommentControlsHandle> | undefined;
  readonly showResolved: boolean;
}

export function CommentControls({
  onShowResolvedChange,
  orphaned,
  ref,
  showResolved,
}: CommentControlsProps): React.JSX.Element {
  const menuRef = useRef<HTMLDivElement>(null);

  useImperativeHandle(
    ref,
    () => ({
      close: () => menuRef.current?.hidePopover(),
      open: () => menuRef.current?.showPopover(),
    }),
    [],
  );

  return (
    <div
      aria-label="Comment controls"
      className="comment-menu"
      id="comment-menu"
      popover="auto"
      ref={menuRef}
    >
      <div className="comment-menu__heading">
        <div>
          <p className="eyebrow">Anchored discussion</p>
          <b>Comments in context</b>
        </div>
        <Button
          aria-label="Close comment controls"
          variant="icon"
          onClick={() => menuRef.current?.hidePopover()}
        >
          ×
        </Button>
      </div>
      <p>Select Markdown or rendered text to reveal its inline comment control.</p>
      <CheckboxField
        checked={showResolved}
        className="resolved-toggle"
        data-show-resolved=""
        label="Show resolved threads"
        onChange={(event) => onShowResolvedChange(event.currentTarget.checked)}
      />
      <div className="orphaned-comments" data-orphaned-comments="" hidden={orphaned.length === 0}>
        {orphaned.length === 0 ? null : (
          <p>
            <b>
              {orphaned.length} orphaned {orphaned.length === 1 ? "thread" : "threads"}
            </b>
            <br />
            Its original text was removed.
          </p>
        )}
        {orphaned.map((projection) => (
          <Button
            data-comment-bubble={projection.thread.id}
            data-comment-surface="preview"
            key={projection.thread.id}
          >
            <span>{projection.thread.messages[0]?.authorDisplayName ?? "Unknown author"}</span>
            {projection.thread.messages[0]?.body ?? "Open comment"}
          </Button>
        ))}
      </div>
    </div>
  );
}
