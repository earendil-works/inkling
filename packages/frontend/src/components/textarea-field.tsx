import { useId } from "react";
import type { ReactNode, Ref, TextareaHTMLAttributes } from "react";

export interface TextareaFieldProps extends Omit<
  TextareaHTMLAttributes<HTMLTextAreaElement>,
  "className"
> {
  readonly className?: string | undefined;
  readonly error?: string | undefined;
  readonly label: ReactNode;
  readonly ref?: Ref<HTMLTextAreaElement> | undefined;
  readonly textareaClassName?: string | undefined;
}

export function TextareaField({
  "aria-describedby": ariaDescribedBy,
  className,
  error,
  id: providedId,
  label,
  ref,
  textareaClassName,
  ...textareaProps
}: TextareaFieldProps): React.JSX.Element {
  const generatedId = useId();
  const id = providedId ?? generatedId;
  const errorId = `${id}-error`;
  const describedBy = [ariaDescribedBy, error === undefined ? undefined : errorId]
    .filter(Boolean)
    .join(" ");

  return (
    <label className={["field", className].filter(Boolean).join(" ")} htmlFor={id}>
      <span className="field__label">{label}</span>
      <textarea
        {...textareaProps}
        aria-describedby={describedBy || undefined}
        aria-invalid={error === undefined ? textareaProps["aria-invalid"] : true}
        className={["field__control", textareaClassName].filter(Boolean).join(" ")}
        id={id}
        ref={ref}
      />
      {error === undefined ? null : (
        <span className="field__error" id={errorId} role="alert">
          {error}
        </span>
      )}
    </label>
  );
}
