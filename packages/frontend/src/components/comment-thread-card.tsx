import { useEffect, useRef } from "react";

import type { CommentThreadDto } from "@earendil-works/jot-protocol";

import { Button } from "./button.tsx";

export interface CommentThreadCardProps {
  readonly anchorRef: React.RefObject<HTMLElement | undefined>;
  readonly anchorRevision: number;
  readonly canManage: boolean;
  readonly onClose: () => void;
  readonly onDeleteMessage: (messageId: string) => void;
  readonly onDeleteThread: () => void;
  readonly onEdit: (messageId: string, body: string) => void;
  readonly onReply: () => void;
  readonly onResolve: () => void;
  readonly thread: CommentThreadDto | undefined;
}

export function CommentThreadCard({
  anchorRef,
  anchorRevision,
  canManage,
  onClose,
  onDeleteMessage,
  onDeleteThread,
  onEdit,
  onReply,
  onResolve,
  thread,
}: CommentThreadCardProps): React.JSX.Element {
  const cardRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const card = cardRef.current;
    if (card === null) return;
    if (thread === undefined) {
      if (card.matches(":popover-open")) card.hidePopover();
      document
        .querySelectorAll(".segment-comment-bubble.is-active")
        .forEach((bubble) => bubble.classList.remove("is-active"));
      return;
    }
    if (!card.matches(":popover-open")) card.showPopover();
    document.querySelectorAll<HTMLElement>("[data-comment-bubble]").forEach((bubble) => {
      bubble.classList.toggle("is-active", bubble.dataset["commentBubble"] === thread.id);
    });
    const position = (): void => {
      if (!card.matches(":popover-open")) return;
      if (matchMedia("(width <= 52rem)").matches) {
        card.style.removeProperty("--comment-card-left");
        card.style.removeProperty("--comment-card-top");
        return;
      }
      const anchor = anchorRef.current;
      if (anchor === undefined || !anchor.isConnected) return;
      const anchorRect = anchor.getBoundingClientRect();
      const cardRect = card.getBoundingClientRect();
      const gap = 12;
      const left = Math.max(
        gap,
        Math.min(
          innerWidth - cardRect.width - gap,
          anchorRect.right + gap + cardRect.width <= innerWidth
            ? anchorRect.right + gap
            : anchorRect.left - cardRect.width - gap,
        ),
      );
      const top = Math.max(gap, Math.min(innerHeight - cardRect.height - gap, anchorRect.top - 18));
      card.style.setProperty("--comment-card-left", `${left}px`);
      card.style.setProperty("--comment-card-top", `${top}px`);
    };
    requestAnimationFrame(position);
    document.addEventListener("scroll", position, true);
    window.addEventListener("resize", position);
    return () => {
      document.removeEventListener("scroll", position, true);
      window.removeEventListener("resize", position);
    };
  }, [anchorRef, anchorRevision, thread]);

  return (
    <aside
      aria-label="Comment thread"
      className="comment-card"
      data-comment-card=""
      popover="auto"
      ref={cardRef}
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
          <div className="comment-actions">
            <Button data-reply-thread={thread.id} onClick={onReply}>
              Reply
            </Button>
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
    </aside>
  );
}
