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
    className: ["lifecycle-state-chip", className].filter(Boolean).join(" "),
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
