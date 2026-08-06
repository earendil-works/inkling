import type { AnchorHTMLAttributes } from "react";

import type { ButtonVariant } from "./button.tsx";

export interface ButtonLinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  readonly size?: "small" | undefined;
  readonly variant: Exclude<ButtonVariant, "icon" | "plain">;
}

export function ButtonLink({
  className,
  size,
  variant,
  ...props
}: ButtonLinkProps): React.JSX.Element {
  const classes = [
    `${variant}-button`,
    variant === "primary" && size === "small" ? "primary-button--small" : undefined,
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return <a {...props} className={classes} />;
}
