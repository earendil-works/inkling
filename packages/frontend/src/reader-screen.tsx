import { Container, Layout, Separator } from "@earendil-works/elanor-react";
import type { DocumentResponse } from "@earendil-works/inkling-protocol";

import type { ApiClientService } from "./api.ts";
import type { AccountControlProps } from "./components/account-control.tsx";
import type { ReferenceResolutionRecord } from "./markdown.tsx";
import type { WikiNavigation as WikiNavigationData } from "./wiki-navigation.ts";

import { ReaderDocument } from "./components/reader-document.tsx";
import { ReaderToolbar } from "./components/reader-toolbar.tsx";
import { WikiDocument } from "./components/wiki-document.tsx";
import { WikiHeader } from "./components/wiki-header.tsx";
import { WikiNavigation } from "./components/wiki-navigation.tsx";
import { WikiSearchDialog, WikiSearchTrigger } from "./components/wiki-search.tsx";
import { wikiReaderPath } from "./wiki-navigation.ts";
import styles from "./workspace.module.css";
import wikiStyles from "./reader-screen.module.css";

export interface ReaderScreenProps {
  readonly account?: AccountControlProps["account"] | undefined;
  readonly api?: ApiClientService | undefined;
  readonly document: DocumentResponse;
  readonly publicDocument?: boolean | undefined;
  readonly references?: ReferenceResolutionRecord | undefined;
  readonly shared: boolean;
  /** The wiki's navigation, for the wiki's index and pages. */
  readonly wiki?: WikiNavigationData | undefined;
}

export function ReaderScreen({
  account,
  api,
  document,
  publicDocument = false,
  references,
  shared,
  wiki,
}: ReaderScreenProps): React.JSX.Element {
  if (wiki === undefined) {
    return (
      <Layout.Main className={styles["layout"]} id="app" tabIndex={-1}>
        <Container>
          <ReaderToolbar
            metadata={document.metadata}
            publicDocument={publicDocument}
            shared={shared}
          />
          <ReaderDocument api={api} document={document} references={references} />
        </Container>
      </Layout.Main>
    );
  }
  // Wiki pages read like Elanor's and pi.dev's docs, in their shell instead of Inkling's
  // (app.tsx leaves Inkling's header out): a top bar, the navigation with the search beside
  // the page, and the page.
  const current = wikiReaderPath(document.metadata, wiki);
  return (
    <div className={wikiStyles["wiki"]} data-wiki="">
      <WikiHeader account={account} api={api} current={current} wiki={wiki} />
      <div className={wikiStyles["navigation"]} data-wiki-covered="">
        <div className={wikiStyles["search"]}>
          <WikiSearchTrigger />
          <Separator />
        </div>
        <div className={wikiStyles["scroll"]}>
          <WikiNavigation current={current} wiki={wiki} />
        </div>
      </div>
      <Layout.Main className={wikiStyles["main"]} data-wiki-covered="" id="app" tabIndex={-1}>
        <Container className={wikiStyles["content"]}>
          <WikiDocument
            api={api}
            document={document}
            editable={!publicDocument && !shared}
            references={references}
          />
        </Container>
      </Layout.Main>
      <WikiSearchDialog api={api} />
    </div>
  );
}
