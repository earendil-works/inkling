import { useEffect, useRef, useState } from "react";
import { Button } from "./button.tsx";
import { DialogHeader } from "./dialog-header.tsx";
import { ModalDialog } from "./modal-dialog.tsx";
import { TextareaField } from "./textarea-field.tsx";

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
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const [body, setBody] = useState(initialBody);
  const [invalid, setInvalid] = useState(false);

  useEffect(() => {
    const textarea = bodyRef.current;
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
    <ModalDialog
      aria-labelledby="comment-composer-dialog-title"
      className="comment-composer-dialog"
      data-comment-composer-dialog=""
      onDismiss={onCancel}
      open
      preventDismiss={pending}
    >
      <form
        className="comment-composer-form"
        data-comment-composer-form=""
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <DialogHeader
          className="comment-composer-heading"
          closeLabel="Cancel comment"
          disabled={pending}
          eyebrow="Discussion"
          onClose={onCancel}
          title={title}
          titleDataAttributes={{ "data-comment-composer-title": "" }}
          titleId="comment-composer-dialog-title"
        />
        {quote === undefined || quote.length === 0 ? null : (
          <blockquote data-comment-composer-quote="">{quote}</blockquote>
        )}
        <TextareaField
          aria-invalid={invalid}
          className="comment-composer-field"
          data-comment-body=""
          error={invalid ? "Enter a comment before submitting." : undefined}
          label="Comment"
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
        <div className="comment-composer-footer">
          <span>
            <kbd>⌘</kbd>
            <kbd>Enter</kbd> to submit
          </span>
          <div>
            <Button
              variant="toolbar"
              data-comment-cancel=""
              disabled={pending}
              onClick={onCancel}
              type="button"
            >
              Cancel
            </Button>
            <Button
              size="small"
              variant="primary"
              data-comment-submit=""
              disabled={pending}
              type="submit"
            >
              {pending ? "Saving…" : submitLabel}
            </Button>
          </div>
        </div>
      </form>
    </ModalDialog>
  );
}
