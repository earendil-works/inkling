import { useId } from "react";
import type { InputHTMLAttributes, ReactNode, Ref } from "react";

import styles from "./form-controls.module.css";

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "className"> {
  readonly className?: string | undefined;
  readonly error?: string | undefined;
  readonly inputClassName?: string | undefined;
  readonly label: ReactNode;
  readonly ref?: Ref<HTMLInputElement> | undefined;
}

export function TextField({
  "aria-describedby": ariaDescribedBy,
  className,
  error,
  id: providedId,
  inputClassName,
  label,
  ref,
  ...inputProps
}: TextFieldProps): React.JSX.Element {
  const generatedId = useId();
  const id = providedId ?? generatedId;
  const errorId = `${id}-error`;
  const describedBy = [ariaDescribedBy, error === undefined ? undefined : errorId]
    .filter(Boolean)
    .join(" ");

  return (
    <label className={[styles["field"], className].filter(Boolean).join(" ")} htmlFor={id}>
      <span className={styles["label"]}>{label}</span>
      <input
        {...inputProps}
        aria-describedby={describedBy || undefined}
        aria-invalid={error === undefined ? inputProps["aria-invalid"] : true}
        className={[styles["control"], inputClassName].filter(Boolean).join(" ")}
        id={id}
        ref={ref}
      />
      {error === undefined ? null : (
        <span className={styles["error"]} id={errorId} role="alert">
          {error}
        </span>
      )}
    </label>
  );
}
