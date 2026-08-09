import type { AnchorHTMLAttributes } from "react";

import styles from "./button.module.css";
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
    styles["base"],
    styles[variant],
    variant === "primary" && size === "small" ? styles["small"] : undefined,
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return <a {...props} className={classes} />;
}
