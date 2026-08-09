import type { ButtonHTMLAttributes } from "react";

import styles from "./button.module.css";

export type ButtonVariant = "icon" | "plain" | "primary" | "text" | "toolbar";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly size?: "small" | undefined;
  readonly variant?: ButtonVariant | undefined;
}

export function Button({
  className,
  size,
  type = "button",
  variant = "plain",
  ...props
}: ButtonProps): React.JSX.Element {
  const classes = [
    styles["base"],
    variant === "plain" ? undefined : styles[variant],
    variant === "primary" && size === "small" ? styles["small"] : undefined,
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return <button {...props} className={classes} type={type} />;
}
