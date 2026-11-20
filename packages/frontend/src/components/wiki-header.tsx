import { useEffect, useState } from "react";

import { SearchIcon } from "@earendil-works/elanor-icons-react";
import { EarendilSymbolMonochrome } from "@earendil-works/elanor-logos-react/earendil/symbol-monochrome";
import { TopNavigation } from "@earendil-works/elanor-react";

import type { ApiClientService } from "../api.ts";
import { WIKI_PATH } from "../ui.ts";
import { AccountControl } from "./account-control.tsx";
import type { AccountControlProps } from "./account-control.tsx";
import { ThemeToggle } from "./theme-toggle.tsx";
import { WikiMenuNavigation } from "./wiki-navigation.tsx";
import type { WikiNavigationProps } from "./wiki-navigation.tsx";
import { wikiSearch } from "./wiki-search.tsx";
import styles from "./wiki-header.module.css";

/*
 * The wiki's top bar, like pi.dev's docs: the Earendil symbol and the wiki's
 * name, which lead to the index, then the theme and the reader's account.
 * Below the wide layout, where the side navigation and its search leave, a
 * search button and the menu with the navigation join them. It replaces
 * Inkling's header on the wiki's pages.
 */

export interface WikiHeaderProps extends WikiNavigationProps {
  readonly account: AccountControlProps["account"] | undefined;
  readonly api: ApiClientService | undefined;
}

export function WikiHeader({ account, api, current, wiki }: WikiHeaderProps): React.JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false);
  // The menu closes when the reader follows one of its links.
  useEffect(() => setMenuOpen(false), [current]);
  // Like pi.dev's docs: the open menu covers the page below the bar, but Elanor's menu
  // neither contains focus nor makes the page inert, so the page is inert while it is open.
  useEffect(() => {
    const covered = document.querySelectorAll<HTMLElement>("[data-wiki-covered]");
    for (const element of covered) element.toggleAttribute("inert", menuOpen);
    return () => {
      for (const element of covered) element.removeAttribute("inert");
    };
  }, [menuOpen]);
  return (
    <TopNavigation.Root className={styles["header"]} data-wiki-header="">
      <TopNavigation.Identity>
        <a aria-label="Wiki home" className={styles["identity"]} href={WIKI_PATH}>
          <EarendilSymbolMonochrome aria-hidden="true" className={styles["mark"]} height="1em" />
          <span>Wiki</span>
        </a>
      </TopNavigation.Identity>
      <TopNavigation.Actions className={styles["actions"]}>
        <TopNavigation.ActionButton
          aria-label="Search the wiki"
          className={styles["search"]}
          onClick={() => wikiSearch.open(null)}
          title="Search the wiki"
        >
          <SearchIcon />
        </TopNavigation.ActionButton>
        <ThemeToggle />
        {api === undefined || account === undefined ? null : (
          <AccountControl account={account} api={api} />
        )}
        <TopNavigation.Menu defaultPanel="wiki" onOpenChange={setMenuOpen} open={menuOpen}>
          <TopNavigation.MenuTrigger aria-label="Wiki menu" className={styles["menuTrigger"]} />
          <TopNavigation.MenuPopup aria-label="Wiki menu" className={styles["menu"]}>
            <nav aria-label="Wiki">
              <TopNavigation.MenuPanel panel="wiki">
                <WikiMenuNavigation current={current} wiki={wiki} />
              </TopNavigation.MenuPanel>
            </nav>
          </TopNavigation.MenuPopup>
        </TopNavigation.Menu>
      </TopNavigation.Actions>
    </TopNavigation.Root>
  );
}
