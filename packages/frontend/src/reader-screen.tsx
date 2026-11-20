import { Container, Layout } from "@earendil-works/elanor-react";
import type { DocumentResponse } from "@earendil-works/inkling-protocol";

import type { ApiClientService } from "./api.ts";
import type { ReferenceResolutionRecord } from "./markdown.tsx";
import type { WikiNavigation as WikiNavigationData } from "./wiki-navigation.ts";

import { ReaderDocument } from "./components/reader-document.tsx";
import { ReaderToolbar } from "./components/reader-toolbar.tsx";
import { WikiNavigation, WikiNavigationDrawer } from "./components/wiki-navigation.tsx";
import { wikiReaderPath } from "./wiki-navigation.ts";
import styles from "./workspace.module.css";
import wikiStyles from "./reader-screen.module.css";

export interface ReaderScreenProps {
  readonly api?: ApiClientService | undefined;
  readonly document: DocumentResponse;
  readonly publicDocument?: boolean | undefined;
  readonly references?: ReferenceResolutionRecord | undefined;
  readonly shared: boolean;
  /** The wiki's navigation, for the wiki's index and pages. */
  readonly wiki?: WikiNavigationData | undefined;
}

export function ReaderScreen({
  api,
  document,
  publicDocument = false,
  references,
  shared,
  wiki,
}: ReaderScreenProps): React.JSX.Element {
  const content = (
    <>
      <ReaderToolbar metadata={document.metadata} publicDocument={publicDocument} shared={shared} />
      <ReaderDocument api={api} document={document} references={references} />
    </>
  );
  if (wiki === undefined) {
    return (
      <Layout.Main className={styles["layout"]} id="app" tabIndex={-1}>
        <Container>{content}</Container>
      </Layout.Main>
    );
  }
  // Wiki pages read beside the wiki's navigation, like a documentation site.
  const current = wikiReaderPath(document.metadata, wiki);
  return (
    <Layout.Body className={wikiStyles["body"]} data-wiki="">
      <Layout.Aside aria-label="Wiki navigation" className={wikiStyles["aside"]}>
        <WikiNavigation current={current} wiki={wiki} />
      </Layout.Aside>
      <Layout.Main className={styles["layout"]} id="app" tabIndex={-1}>
        <Container>
          <div className={wikiStyles["drawer"]}>
            <WikiNavigationDrawer current={current} wiki={wiki} />
          </div>
          {content}
        </Container>
      </Layout.Main>
    </Layout.Body>
  );
}
