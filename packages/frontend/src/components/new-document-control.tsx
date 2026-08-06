import { useState } from "react";

import type { ApiClientService } from "../api.ts";
import { Button } from "./button.tsx";
import { NewDocumentDialog } from "./new-document-dialog.tsx";

export interface NewDocumentControlProps {
  readonly api: ApiClientService;
}

export function NewDocumentControl({ api }: NewDocumentControlProps): React.JSX.Element {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button variant="primary" data-new-document="" onClick={() => setOpen(true)}>
        New document
      </Button>
      <NewDocumentDialog api={api} onDismiss={() => setOpen(false)} open={open} />
    </>
  );
}
