import type { HTMLAttributes } from "react";

import styles from "./form-error.module.css";

export interface FormErrorProps extends Omit<HTMLAttributes<HTMLParagraphElement>, "role"> {}

export function FormError({ className, ...props }: FormErrorProps): React.JSX.Element {
  return (
    <p
      {...props}
      aria-live="polite"
      className={[styles["error"], className].filter(Boolean).join(" ")}
      role="alert"
    />
  );
}
