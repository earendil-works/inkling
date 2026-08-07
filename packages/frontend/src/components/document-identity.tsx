export interface DocumentIdentityProps {
  readonly rfcNumber: number | undefined;
  readonly title: string;
}

export function DocumentIdentity({ rfcNumber, title }: DocumentIdentityProps): React.JSX.Element {
  return (
    <div className="document-identity">
      <span>
        {rfcNumber === undefined ? "Document" : `RFC ${String(rfcNumber).padStart(4, "0")}`}
      </span>
      <strong className="title-input" data-title="">
        {title}
      </strong>
    </div>
  );
}
