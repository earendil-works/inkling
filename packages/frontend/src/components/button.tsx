import type { ButtonHTMLAttributes } from "react";

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
    variant === "plain" ? undefined : `${variant}-button`,
    variant === "primary" && size === "small" ? "primary-button--small" : undefined,
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return <button {...props} className={classes || undefined} type={type} />;
}
