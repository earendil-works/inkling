import type { DocumentMetadataDto } from "@earendil-works/jot-protocol";

import type { ApiClientService, ApiError } from "../api.ts";
import { useAppContext } from "../app-context.tsx";
import { useEffectAction } from "../effect-hooks.ts";
import { documentHref } from "../ui.ts";
import { Button } from "./button.tsx";

export interface AllocateRfcButtonProps {
  readonly api: ApiClientService;
  readonly canAllocate: boolean;
  readonly metadata: DocumentMetadataDto;
  readonly onAllocated: (metadata: DocumentMetadataDto) => void;
}

export function AllocateRfcButton({
  api,
  canAllocate,
  metadata,
  onAllocated,
}: AllocateRfcButtonProps): React.JSX.Element | null {
  const { navigate, showToast } = useAppContext();
  const allocation = useEffectAction<undefined, DocumentMetadataDto, ApiError>(() =>
    api.allocateRfc(metadata.id),
  );

  if (!canAllocate || metadata.rfcNumber !== undefined) return null;

  return (
    <Button
      data-allocate-rfc=""
      disabled={allocation.state.pending}
      onClick={() =>
        allocation.execute(undefined, {
          onFailure: (error) => showToast(error.message, "error"),
          onSuccess: (allocated) => {
            onAllocated(allocated);
            navigate(documentHref(allocated.id, allocated.rfcNumber, false, "edit", ""), {
              replace: true,
            });
          },
        })
      }
      variant="toolbar"
    >
      {allocation.state.pending ? "Allocating…" : "Allocate RFC"}
    </Button>
  );
}
