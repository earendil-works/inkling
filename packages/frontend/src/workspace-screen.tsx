import { useEffect, useState } from "react";

import { Container, Layout, Page, PageHeader } from "@earendil-works/elanor-react";
import type { CatalogResponse } from "@earendil-works/inkling-protocol";

import type { ApiClientService } from "./api.ts";
import { CatalogControls } from "./components/catalog-controls.tsx";
import { DocumentCatalog } from "./components/document-catalog.tsx";
import { NewDocumentControl } from "./components/new-document-control.tsx";
import styles from "./workspace.module.css";

export interface WorkspaceScreenProps {
  readonly api: ApiClientService;
  readonly initialCatalog: CatalogResponse;
  readonly publicCatalog?: boolean | undefined;
  readonly signedIn?: boolean | undefined;
}

export function WorkspaceScreen({
  api,
  initialCatalog,
  publicCatalog = false,
  signedIn = false,
}: WorkspaceScreenProps): React.JSX.Element {
  const [catalog, setCatalog] = useState(initialCatalog);

  useEffect(() => setCatalog(initialCatalog), [initialCatalog]);

  return (
    <Layout.Main
      className={styles["layout"]}
      data-public-catalog={publicCatalog ? "" : undefined}
      data-workspace-layout=""
      id="app"
      tabIndex={-1}
    >
      <Container>
        <Page>
          <PageHeader.Root data-workspace-heading="">
            <PageHeader.Row>
              <PageHeader.Title level={1}>Inkling</PageHeader.Title>
              {publicCatalog ? null : (
                <PageHeader.Actions>
                  <NewDocumentControl api={api} />
                </PageHeader.Actions>
              )}
            </PageHeader.Row>
            {publicCatalog ? (
              <PageHeader.Description className={styles["description"]}>
                Public archive / published revisions
              </PageHeader.Description>
            ) : null}
          </PageHeader.Root>
          <CatalogControls
            api={api}
            initialCatalog={initialCatalog}
            onResultsChange={setCatalog}
            publicCatalog={publicCatalog}
            signedIn={signedIn}
          />
          <DocumentCatalog catalog={catalog} publicCatalog={publicCatalog} />
        </Page>
      </Container>
    </Layout.Main>
  );
}
