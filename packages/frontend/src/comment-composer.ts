import { Effect } from "effect";

export interface CommentComposerOptions {
  readonly initialBody?: string | undefined;
  readonly quote?: string | undefined;
  readonly submitLabel: string;
  readonly title: string;
}

/** Opens an accessible in-app comment editor and returns undefined when cancelled. */
export function composeComment(options: CommentComposerOptions): Effect.Effect<string | undefined> {
  return Effect.async<string | undefined>((resume) => {
    const dialog = document.createElement("dialog");
    dialog.className = "comment-composer-dialog";
    dialog.dataset["commentComposerDialog"] = "";
    dialog.innerHTML = `
      <form class="comment-composer-form" data-comment-composer-form>
        <div class="comment-composer-heading">
          <div><p class="eyebrow">Discussion</p><h2 data-comment-composer-title></h2></div>
          <button class="icon-button" type="button" data-comment-cancel aria-label="Cancel comment">×</button>
        </div>
        <blockquote data-comment-composer-quote></blockquote>
        <label class="comment-composer-field">Comment
          <textarea data-comment-body maxlength="20000" rows="7" required placeholder="Write a clear, useful comment…"></textarea>
        </label>
        <div class="comment-composer-footer">
          <span><kbd>⌘</kbd><kbd>Enter</kbd> to submit</span>
          <div>
            <button class="toolbar-button" type="button" data-comment-cancel>Cancel</button>
            <button class="primary-button primary-button--small" type="submit" data-comment-submit></button>
          </div>
        </div>
      </form>`;

    const title = requireElement<HTMLElement>(dialog, "[data-comment-composer-title]");
    const quote = requireElement<HTMLElement>(dialog, "[data-comment-composer-quote]");
    const body = requireElement<HTMLTextAreaElement>(dialog, "[data-comment-body]");
    const submit = requireElement<HTMLButtonElement>(dialog, "[data-comment-submit]");
    const form = requireElement<HTMLFormElement>(dialog, "[data-comment-composer-form]");
    title.textContent = options.title;
    quote.textContent = options.quote ?? "";
    quote.hidden = options.quote === undefined || options.quote.length === 0;
    body.value = options.initialBody ?? "";
    submit.textContent = options.submitLabel;
    document.body.append(dialog);

    let settled = false;
    const finish = (value: string | undefined): void => {
      if (settled) return;
      settled = true;
      if (dialog.open) dialog.close();
      dialog.remove();
      resume(Effect.succeed(value));
    };
    const submitComment = (): void => {
      const value = body.value.trim();
      if (value.length === 0) {
        body.setCustomValidity("Enter a comment before submitting.");
        body.reportValidity();
        return;
      }
      body.setCustomValidity("");
      finish(value);
    };
    const handleSubmit = (event: SubmitEvent): void => {
      event.preventDefault();
      submitComment();
    };
    const handleKeydown = (event: KeyboardEvent): void => {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        submitComment();
      }
    };
    const handleCancel = (event: Event): void => {
      event.preventDefault();
      finish(undefined);
    };

    form.addEventListener("submit", handleSubmit);
    body.addEventListener("keydown", handleKeydown);
    dialog.addEventListener("cancel", handleCancel);
    dialog.querySelectorAll<HTMLElement>("[data-comment-cancel]").forEach((button) => {
      button.addEventListener("click", handleCancel);
    });
    dialog.showModal();
    body.focus();
    body.setSelectionRange(body.value.length, body.value.length);

    return Effect.sync(() => {
      settled = true;
      if (dialog.open) dialog.close();
      dialog.remove();
    });
  });
}

function requireElement<ElementType extends Element>(
  parent: ParentNode,
  selector: string,
): ElementType {
  const element = parent.querySelector<ElementType>(selector);
  if (element === null) throw new Error(`Missing comment composer element: ${selector}`);
  return element;
}
