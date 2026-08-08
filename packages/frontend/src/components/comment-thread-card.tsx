import { useEffect } from "react";

import type { CommentThreadDto } from "@earendil-works/inkling-protocol";

import { AnchoredPopover } from "./anchored-popover.tsx";
import { Button } from "./button.tsx";
import { CommentComposer } from "./comment-composer.tsx";

export interface CommentThreadCardProps {
  readonly anchorRef: React.RefObject<HTMLElement | undefined>;
  readonly anchorRevision: number;
  readonly canManage: boolean;
  readonly canReply: boolean;
  readonly onClose: () => void;
  readonly onDeleteMessage: (messageId: string) => void;
  readonly onDeleteThread: () => void;
  readonly onEdit: (messageId: string, body: string) => void;
  readonly onReply: () => void;
  readonly onResolve: () => void;
  readonly replyComposer:
    | {
        readonly onCancel: () => void;
        readonly onSubmit: (body: string) => void;
        readonly pending: boolean;
      }
    | undefined;
  readonly thread: CommentThreadDto | undefined;
}

export function CommentThreadCard({
  anchorRef,
  anchorRevision,
  canManage,
  canReply,
  onClose,
  onDeleteMessage,
  onDeleteThread,
  onEdit,
  onReply,
  onResolve,
  replyComposer,
  thread,
}: CommentThreadCardProps): React.JSX.Element {
  useEffect(() => {
    document.querySelectorAll<HTMLElement>("[data-comment-bubble]").forEach((bubble) => {
      bubble.classList.toggle(
        "is-active",
        thread !== undefined && bubble.dataset["commentBubble"] === thread.id,
      );
    });
    return () => {
      document
        .querySelectorAll(".segment-comment-bubble.is-active")
        .forEach((bubble) => bubble.classList.remove("is-active"));
    };
  }, [thread]);

  return (
    <AnchoredPopover
      anchorRef={anchorRef}
      anchorRevision={anchorRevision}
      aria-label="Comment thread"
      className="comment-card"
      data-comment-card=""
      open={thread !== undefined}
    >
      {thread === undefined ? null : (
        <section className={`comment-thread ${thread.resolved ? "is-resolved" : ""}`}>
          <div className="comment-thread__heading">
            <span>Thread</span>
            <Button
              aria-label="Close comment thread"
              variant="icon"
              data-comment-close=""
              onClick={onClose}
            >
              ×
            </Button>
          </div>
          <blockquote>{thread.anchor.quote || "Orphaned selection"}</blockquote>
          {thread.messages.map((message) => (
            <div className="comment-message" key={message.id}>
              <b>{message.authorDisplayName}</b>
              <p>{message.body}</p>
              <span>
                <Button
                  data-edit-message={`${thread.id}:${message.id}`}
                  onClick={() => onEdit(message.id, message.body)}
                >
                  Edit
                </Button>
                <Button
                  data-delete-message={`${thread.id}:${message.id}`}
                  onClick={() => onDeleteMessage(message.id)}
                >
                  Delete
                </Button>
              </span>
            </div>
          ))}
          {replyComposer === undefined ? null : (
            <CommentComposer
              onCancel={replyComposer.onCancel}
              onSubmit={replyComposer.onSubmit}
              pending={replyComposer.pending}
              presentation="inline"
              submitLabel="Reply"
              title="Reply to thread"
            />
          )}
          <div className="comment-actions">
            {canReply && replyComposer === undefined ? (
              <Button data-reply-thread={thread.id} onClick={onReply}>
                Reply
              </Button>
            ) : null}
            <Button data-resolve-thread={thread.id} onClick={onResolve}>
              {thread.resolved ? "Reopen" : "Resolve"}
            </Button>
            {canManage ? (
              <Button data-delete-thread={thread.id} onClick={onDeleteThread}>
                Delete thread
              </Button>
            ) : null}
          </div>
        </section>
      )}
    </AnchoredPopover>
  );
}
