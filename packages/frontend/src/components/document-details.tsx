import { useEffect, useState } from "react";

import type { DocumentMetadataDto } from "@earendil-works/jot-protocol";

import type { ApiClientService, ApiError } from "../api.ts";
import { useEffectAction } from "../effect-hooks.ts";
import { Button } from "./button.tsx";
import { ConfirmationDialog } from "./confirmation-dialog.tsx";
import { FormError } from "./form-error.tsx";
import { SelectField } from "./select-field.tsx";
import { TextField } from "./text-field.tsx";

export interface DocumentDetailsProps {
  readonly api: ApiClientService;
  readonly canEdit: boolean;
  readonly metadata: DocumentMetadataDto;
  readonly onMetadataChanged: (metadata: DocumentMetadataDto) => void;
  readonly onUpdate: (input: Readonly<Record<string, unknown>>) => void;
}

export function DocumentDetails({
  api,
  canEdit,
  metadata,
  onMetadataChanged,
  onUpdate,
}: DocumentDetailsProps): React.JSX.Element {
  const [labels, setLabels] = useState(metadata.labels.join(", "));
  const [confirmPublic, setConfirmPublic] = useState(false);
  const allocation = useEffectAction<undefined, DocumentMetadataDto, ApiError>(() =>
    api.allocateRfc(metadata.id),
  );

  useEffect(() => {
    setLabels(metadata.labels.join(", "));
  }, [metadata.labels]);

  return (
    <>
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
            {[
              metadata.lifecycleState,
              "draft",
              "discussion",
              "accepted",
              "implemented",
              "abandoned",
            ]
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
              if (visibility === "public" && metadata.sensitivity === "confidential") {
                setConfirmPublic(true);
              } else {
                onUpdate({ visibility });
              }
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
          {metadata.rfcNumber === undefined && canEdit ? (
            <div className="document-details__allocation">
              <Button
                data-allocate-rfc=""
                disabled={allocation.state.pending}
                onClick={() =>
                  allocation.execute(undefined, {
                    onSuccess: onMetadataChanged,
                  })
                }
                size="small"
                variant="primary"
              >
                {allocation.state.pending ? "Allocating…" : "Allocate RFC number"}
              </Button>
              <FormError>{allocation.state.error?.message}</FormError>
            </div>
          ) : null}
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
      <ConfirmationDialog
        confirmLabel="Make public"
        description="The document is marked confidential. Making its metadata public can expose sensitive information."
        onCancel={() => setConfirmPublic(false)}
        onConfirm={() => {
          setConfirmPublic(false);
          onUpdate({ confirmConfidentialPublic: true, visibility: "public" });
        }}
        open={confirmPublic}
        title="Publish confidential metadata?"
        tone="danger"
      />
    </>
  );
}
