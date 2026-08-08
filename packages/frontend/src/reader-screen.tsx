import { useEffect } from "react";

import type { DocumentResponse } from "@earendil-works/inkling-protocol";

import { useAppContext } from "./app-context.tsx";
import { ReaderDocument } from "./components/reader-document.tsx";
import { ReaderToolbar } from "./components/reader-toolbar.tsx";

export interface ReaderScreenProps {
  readonly document: DocumentResponse;
  readonly publicDocument?: boolean | undefined;
  readonly shared: boolean;
}

export function ReaderScreen({
  document,
  publicDocument = false,
  shared,
}: ReaderScreenProps): React.JSX.Element {
  const { setParticipants } = useAppContext();
  useEffect(() => {
    setParticipants([]);
  }, [setParticipants]);

  return (
    <main className="reader-layout" id="app" tabIndex={-1}>
      <div className="reader-paper">
        <ReaderToolbar
          metadata={document.metadata}
          publicDocument={publicDocument}
          shared={shared}
        />
        <ReaderDocument document={document} />
      </div>
    </main>
  );
}
