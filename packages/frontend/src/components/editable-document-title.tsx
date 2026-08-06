import { useEffect, useState } from "react";

export interface EditableDocumentTitleProps {
  readonly canEdit: boolean;
  readonly onCommit: (title: string) => void;
  readonly rfcNumber: number | undefined;
  readonly title: string;
}

export function EditableDocumentTitle({
  canEdit,
  onCommit,
  rfcNumber,
  title,
}: EditableDocumentTitleProps): React.JSX.Element {
  const [draft, setDraft] = useState(title);

  useEffect(() => {
    setDraft(title);
  }, [title]);

  const commit = (): void => {
    const nextTitle = draft.trim();
    if (nextTitle === "") {
      setDraft(title);
    } else if (nextTitle !== title) {
      setDraft(nextTitle);
      onCommit(nextTitle);
    }
  };

  return (
    <div className="document-identity">
      <span>
        {rfcNumber === undefined ? "Document" : `RFC ${String(rfcNumber).padStart(4, "0")}`}
      </span>
      <input
        aria-label="Document title"
        className="title-input"
        data-title=""
        disabled={!canEdit}
        maxLength={300}
        onBlur={commit}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") {
            setDraft(title);
            event.currentTarget.blur();
          }
        }}
        value={draft}
      />
    </div>
  );
}
