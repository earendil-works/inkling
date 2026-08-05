import { useEffect, useRef, useState } from "react";

export interface CommentComposerProps {
  readonly initialBody?: string | undefined;
  readonly onCancel: () => void;
  readonly onSubmit: (body: string) => void;
  readonly pending: boolean;
  readonly quote?: string | undefined;
  readonly submitLabel: string;
  readonly title: string;
}

export function CommentComposer({
  initialBody = "",
  onCancel,
  onSubmit,
  pending,
  quote,
  submitLabel,
  title,
}: CommentComposerProps): React.JSX.Element {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const [body, setBody] = useState(initialBody);
  const [invalid, setInvalid] = useState(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    const textarea = bodyRef.current;
    dialog?.showModal();
    textarea?.focus();
    textarea?.setSelectionRange(textarea.value.length, textarea.value.length);
  }, []);

  const submit = (): void => {
    const value = body.trim();
    if (value === "") {
      setInvalid(true);
      bodyRef.current?.focus();
      return;
    }
    setInvalid(false);
    onSubmit(value);
  };

  return (
    <dialog
      className="comment-composer-dialog"
      data-comment-composer-dialog=""
      onCancel={(event) => {
        event.preventDefault();
        if (!pending) onCancel();
      }}
      ref={dialogRef}
    >
      <form
        className="comment-composer-form"
        data-comment-composer-form=""
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div className="comment-composer-heading">
          <div>
            <p className="eyebrow">Discussion</p>
            <h2 data-comment-composer-title="">{title}</h2>
          </div>
          <button
            aria-label="Cancel comment"
            className="icon-button"
            data-comment-cancel=""
            disabled={pending}
            onClick={onCancel}
            type="button"
          >
            ×
          </button>
        </div>
        {quote === undefined || quote.length === 0 ? null : (
          <blockquote data-comment-composer-quote="">{quote}</blockquote>
        )}
        <label className="comment-composer-field">
          Comment
          <textarea
            aria-invalid={invalid}
            data-comment-body=""
            maxLength={20_000}
            onChange={(event) => {
              setBody(event.currentTarget.value);
              if (invalid) setInvalid(false);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                submit();
              }
            }}
            placeholder="Write a clear, useful comment…"
            ref={bodyRef}
            required
            rows={7}
            value={body}
          />
        </label>
        {invalid ? <p className="form-error">Enter a comment before submitting.</p> : null}
        <div className="comment-composer-footer">
          <span>
            <kbd>⌘</kbd>
            <kbd>Enter</kbd> to submit
          </span>
          <div>
            <button
              className="toolbar-button"
              data-comment-cancel=""
              disabled={pending}
              onClick={onCancel}
              type="button"
            >
              Cancel
            </button>
            <button
              className="primary-button primary-button--small"
              data-comment-submit=""
              disabled={pending}
              type="submit"
            >
              {pending ? "Saving…" : submitLabel}
            </button>
          </div>
        </div>
      </form>
    </dialog>
  );
}
