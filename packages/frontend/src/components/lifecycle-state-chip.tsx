import styles from "./lifecycle-state-chip.module.css";

export interface LifecycleStateChipProps {
  readonly className?: string | undefined;
  readonly href?: string | undefined;
  readonly state: string;
}

export function LifecycleStateChip({
  className,
  href,
  state,
}: LifecycleStateChipProps): React.JSX.Element {
  const properties = {
    className: [styles["root"], className].filter(Boolean).join(" "),
    "data-lifecycle-state": state.trim().toLocaleLowerCase("en"),
  };
  return href === undefined ? (
    <span {...properties}>{state}</span>
  ) : (
    <a {...properties} href={href}>
      {state}
    </a>
  );
}
