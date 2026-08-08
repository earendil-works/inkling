export interface LifecycleStateChipProps {
  readonly className?: string | undefined;
  readonly state: string;
}

export function LifecycleStateChip({
  className,
  state,
}: LifecycleStateChipProps): React.JSX.Element {
  return (
    <span
      className={["lifecycle-state-chip", className].filter(Boolean).join(" ")}
      data-lifecycle-state={state.trim().toLocaleLowerCase("en")}
    >
      {state}
    </span>
  );
}
