import { useEffect } from "react";

import type { DocumentResponse } from "@earendil-works/jot-protocol";

import { useAppContext } from "./app-context.tsx";
import { ReaderDocument } from "./components/reader-document.tsx";
import { ReaderToolbar } from "./components/reader-toolbar.tsx";

export interface ReaderScreenProps {
  readonly document: DocumentResponse;
  readonly shared: boolean;
}

export function ReaderScreen({ document, shared }: ReaderScreenProps): React.JSX.Element {
  const { setParticipants, setStatus } = useAppContext();
  useEffect(() => {
    setParticipants([]);
    setStatus({ label: "Document loaded", state: "ready" });
  }, [setParticipants, setStatus]);

  return (
    <main className="reader-layout" id="app" tabIndex={-1}>
      <ReaderToolbar metadata={document.metadata} shared={shared} />
      <ReaderDocument document={document} />
    </main>
  );
}
