import { Container, Layout } from "@earendil-works/elanor-react";
import type { DocumentResponse } from "@earendil-works/inkling-protocol";

import type { ApiClientService } from "./api.ts";
import type { ReferenceResolutionRecord } from "./markdown.tsx";

import { ReaderDocument } from "./components/reader-document.tsx";
import { ReaderToolbar } from "./components/reader-toolbar.tsx";
import styles from "./workspace.module.css";

export interface ReaderScreenProps {
  readonly api?: ApiClientService | undefined;
  readonly document: DocumentResponse;
  readonly publicDocument?: boolean | undefined;
  readonly references?: ReferenceResolutionRecord | undefined;
  readonly shared: boolean;
}

export function ReaderScreen({
  api,
  document,
  publicDocument = false,
  references,
  shared,
}: ReaderScreenProps): React.JSX.Element {
  return (
    <Layout.Main className={styles["layout"]} id="app" tabIndex={-1}>
      <Container>
        <ReaderToolbar
          document={document}
          publicDocument={publicDocument}
          references={references}
          shared={shared}
        />
        <ReaderDocument api={api} document={document} references={references} />
      </Container>
    </Layout.Main>
  );
}
