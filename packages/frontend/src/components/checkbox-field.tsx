import { useId } from "react";
import type { InputHTMLAttributes, ReactNode, Ref } from "react";

export interface CheckboxFieldProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "className" | "type"
> {
  readonly className?: string | undefined;
  readonly label: ReactNode;
  readonly ref?: Ref<HTMLInputElement> | undefined;
}

export function CheckboxField({
  className,
  id: providedId,
  label,
  ref,
  ...inputProps
}: CheckboxFieldProps): React.JSX.Element {
  const generatedId = useId();
  const id = providedId ?? generatedId;

  return (
    <label className={["checkbox-field", className].filter(Boolean).join(" ")} htmlFor={id}>
      <input {...inputProps} id={id} ref={ref} type="checkbox" />
      <span>{label}</span>
    </label>
  );
}
