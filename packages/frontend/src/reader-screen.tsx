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
  const { setParticipants } = useAppContext();
  useEffect(() => {
    setParticipants([]);
  }, [setParticipants]);

  return (
    <main className="reader-layout" id="app" tabIndex={-1}>
      <div className="reader-paper">
        <ReaderToolbar metadata={document.metadata} shared={shared} />
        <ReaderDocument document={document} />
      </div>
    </main>
  );
}
