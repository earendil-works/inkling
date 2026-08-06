import type { HTMLAttributes } from "react";

export interface FormErrorProps extends Omit<HTMLAttributes<HTMLParagraphElement>, "role"> {}

export function FormError({ className, ...props }: FormErrorProps): React.JSX.Element {
  return (
    <p
      {...props}
      aria-live="polite"
      className={["form-error", className].filter(Boolean).join(" ")}
      role="alert"
    />
  );
}
