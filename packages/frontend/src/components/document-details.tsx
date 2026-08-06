import { useEffect, useState } from "react";

import type { DocumentMetadataDto } from "@earendil-works/jot-protocol";

import { SelectField } from "./select-field.tsx";
import { TextField } from "./text-field.tsx";

export interface DocumentDetailsProps {
  readonly canEdit: boolean;
  readonly metadata: DocumentMetadataDto;
  readonly onUpdate: (input: Readonly<Record<string, unknown>>) => void;
}

export function DocumentDetails({
  canEdit,
  metadata,
  onUpdate,
}: DocumentDetailsProps): React.JSX.Element {
  const [labels, setLabels] = useState(metadata.labels.join(", "));

  useEffect(() => {
    setLabels(metadata.labels.join(", "));
  }, [metadata.labels]);

  return (
    <details className="document-details" data-document-details="">
      <summary className="toolbar-button">Details</summary>
      <div className="document-details__menu">
        <SelectField
          data-state=""
          disabled={!canEdit}
          label="State"
          onChange={(event) => onUpdate({ lifecycleState: event.currentTarget.value })}
          value={metadata.lifecycleState}
        >
          {[metadata.lifecycleState, "draft", "discussion", "accepted", "implemented", "abandoned"]
            .filter((value, index, values) => values.indexOf(value) === index)
            .map((value) => (
              <option key={value}>{value}</option>
            ))}
        </SelectField>
        <SelectField
          data-visibility=""
          disabled={!canEdit}
          label="Visibility"
          onChange={(event) => {
            const visibility = event.currentTarget.value === "public" ? "public" : "workspace";
            if (
              visibility === "public" &&
              metadata.sensitivity === "confidential" &&
              !window.confirm("Publish confidential metadata as public?")
            ) {
              event.currentTarget.value = metadata.visibility;
              return;
            }
            onUpdate({
              confirmConfidentialPublic: visibility === "public",
              visibility,
            });
          }}
          value={metadata.visibility}
        >
          <option value="workspace">Workspace</option>
          <option value="public">Public</option>
        </SelectField>
        <SelectField
          data-sensitivity=""
          disabled={!canEdit}
          label="Sensitivity"
          onChange={(event) => onUpdate({ sensitivity: event.currentTarget.value })}
          value={metadata.sensitivity}
        >
          <option value="normal">Normal</option>
          <option value="confidential">Confidential</option>
        </SelectField>
        <TextField
          data-labels=""
          disabled={!canEdit}
          label="Labels"
          onBlur={() =>
            onUpdate({
              labels: labels
                .split(",")
                .map((label) => label.trim())
                .filter(Boolean),
            })
          }
          onChange={(event) => setLabels(event.currentTarget.value)}
          placeholder="Comma separated"
          value={labels}
        />
      </div>
    </details>
  );
}
