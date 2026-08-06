import { useId } from "react";
import type { ReactNode, Ref, SelectHTMLAttributes } from "react";

export interface SelectFieldProps extends Omit<
  SelectHTMLAttributes<HTMLSelectElement>,
  "className"
> {
  readonly className?: string | undefined;
  readonly error?: string | undefined;
  readonly label: ReactNode;
  readonly ref?: Ref<HTMLSelectElement> | undefined;
  readonly selectClassName?: string | undefined;
}

export function SelectField({
  "aria-describedby": ariaDescribedBy,
  children,
  className,
  error,
  id: providedId,
  label,
  ref,
  selectClassName,
  ...selectProps
}: SelectFieldProps): React.JSX.Element {
  const generatedId = useId();
  const id = providedId ?? generatedId;
  const errorId = `${id}-error`;
  const describedBy = [ariaDescribedBy, error === undefined ? undefined : errorId]
    .filter(Boolean)
    .join(" ");

  return (
    <label className={["field", className].filter(Boolean).join(" ")} htmlFor={id}>
      <span className="field__label">{label}</span>
      <select
        {...selectProps}
        aria-describedby={describedBy || undefined}
        aria-invalid={error === undefined ? selectProps["aria-invalid"] : true}
        className={["field__control", selectClassName].filter(Boolean).join(" ")}
        id={id}
        ref={ref}
      >
        {children}
      </select>
      {error === undefined ? null : (
        <span className="field__error" id={errorId} role="alert">
          {error}
        </span>
      )}
    </label>
  );
}
