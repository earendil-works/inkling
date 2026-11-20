import { useEffect, useState } from "react";

import { CloseIcon, MenuIcon } from "@earendil-works/elanor-icons-react";
import { Drawer, IconButton, Link, SideNavigation } from "@earendil-works/elanor-react";

import { WIKI_PATH } from "../ui.ts";
import { containsWikiPath } from "../wiki-navigation.ts";
import type {
  WikiNavigation as WikiNavigationData,
  WikiNavigationItem,
} from "../wiki-navigation.ts";
import { ThemeToggle } from "./theme-toggle.tsx";
import styles from "./wiki-navigation.module.css";

/*
 * The wiki's navigation, like pi.dev's documentation rail: the wiki's name,
 * which leads to the index, then the index's groups with sections that fold,
 * and at the bottom a way back to Inkling and the theme. A section opens on
 * the pages inside it; one the reader opens or closes stays that way while
 * they browse the wiki. Full height beside the page on wide screens; on
 * narrow ones, a bar with the wiki's name opens it in a side panel.
 */

/**
 * Sections the reader opened or closed, by their place in the navigation, for
 * this tab. Only the browser keeps them: the server renders every reader's
 * pages and must not share one reader's choices with the next.
 */
const sectionStates = new Map<string, boolean>();
const remembers = typeof window !== "undefined";

export interface WikiNavigationProps {
  readonly wiki: WikiNavigationData;
  /** The reader path of the page shown, `/wiki` for the index. */
  readonly current: string;
}

/** The index's groups, pages, and sections. */
function WikiNavigation({ wiki, current }: WikiNavigationProps): React.JSX.Element {
  return (
    <SideNavigation.Root aria-label="Wiki" className={styles["navigation"]} data-wiki-navigation="">
      {wiki.groups.map((group, index) => {
        const labelId = `wiki-navigation-group-${index}`;
        return (
          <SideNavigation.Group key={`${group.label ?? ""}:${index}`}>
            {group.label === undefined ? null : (
              <SideNavigation.GroupLabel id={labelId}>{group.label}</SideNavigation.GroupLabel>
            )}
            <WikiList
              current={current}
              items={group.items}
              labelledBy={group.label === undefined ? undefined : labelId}
              path={String(index)}
            />
          </SideNavigation.Group>
        );
      })}
    </SideNavigation.Root>
  );
}

function WikiList({
  current,
  items,
  labelledBy,
  path,
}: {
  readonly current: string;
  readonly items: readonly WikiNavigationItem[];
  readonly labelledBy?: string | undefined;
  readonly path: string;
}): React.JSX.Element {
  return (
    <SideNavigation.List aria-labelledby={labelledBy}>
      {items.map((item, index) => {
        const itemPath = `${path}/${index}`;
        return item.kind === "section" ? (
          <SideNavigation.Item key={itemPath}>
            <WikiSection current={current} item={item} path={itemPath} />
          </SideNavigation.Item>
        ) : (
          <SideNavigation.Item key={itemPath}>
            <SideNavigation.Link active={item.href === current} href={item.href}>
              {item.label}
            </SideNavigation.Link>
            {item.items.length === 0 ? null : (
              <WikiList current={current} items={item.items} path={itemPath} />
            )}
          </SideNavigation.Item>
        );
      })}
    </SideNavigation.List>
  );
}

function WikiSection({
  current,
  item,
  path,
}: {
  readonly current: string;
  readonly item: WikiNavigationItem;
  readonly path: string;
}): React.JSX.Element {
  const key = `${path}:${item.label}`;
  const [, setChanges] = useState(0);
  // As the reader left it; otherwise open on the pages inside it.
  const open =
    (remembers ? sectionStates.get(key) : undefined) ?? containsWikiPath(item.items, current);
  return (
    <SideNavigation.Collapsible
      onOpenChange={(next) => {
        if (remembers) sectionStates.set(key, next);
        setChanges((count) => count + 1);
      }}
      open={open}
    >
      <SideNavigation.CollapsibleTrigger>{item.label}</SideNavigation.CollapsibleTrigger>
      <SideNavigation.CollapsiblePanel>
        <WikiList current={current} items={item.items} path={path} />
      </SideNavigation.CollapsiblePanel>
    </SideNavigation.Collapsible>
  );
}

/** The wiki's name, leading to the index. */
function WikiIdentity({ wiki, current }: WikiNavigationProps): React.JSX.Element {
  return (
    <Link
      aria-current={current === WIKI_PATH ? "page" : undefined}
      className={styles["identity"]}
      data-wiki-index=""
      href={WIKI_PATH}
    >
      {wiki.title}
    </Link>
  );
}

/** Back to Inkling, and the theme. */
function WikiFooter(): React.JSX.Element {
  return (
    <div className={styles["footer"]}>
      <Link className={styles["inkling"]} href="/">
        Inkling
      </Link>
      <ThemeToggle />
    </div>
  );
}

/** The full-height rail beside a wiki page on wide screens. */
export function WikiRail({ wiki, current }: WikiNavigationProps): React.JSX.Element {
  return (
    <div className={styles["rail"]}>
      <WikiIdentity current={current} wiki={wiki} />
      <div className={styles["scroll"]}>
        <WikiNavigation current={current} wiki={wiki} />
      </div>
      <WikiFooter />
    </div>
  );
}

/**
 * The bar above a wiki page on narrow screens, where the rail leaves: the
 * wiki's name, and a button that opens the navigation in a side panel, which
 * closes when the reader moves on.
 */
export function WikiBar({ wiki, current }: WikiNavigationProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [current]);
  // The bar only shows below the wide layout; an open panel closes rather than hides there.
  useEffect(() => {
    const wide = matchMedia("(width >= 64rem)");
    const close = () => {
      if (wide.matches) setOpen(false);
    };
    wide.addEventListener("change", close);
    return () => wide.removeEventListener("change", close);
  }, []);
  return (
    <div className={styles["bar"]} data-wiki-bar="">
      <WikiIdentity current={current} wiki={wiki} />
      <Drawer.Root onOpenChange={setOpen} open={open} swipeDirection="left">
        <Drawer.Trigger
          render={
            <IconButton aria-label="Open the wiki navigation" data-wiki-navigation-trigger="" />
          }
        >
          <MenuIcon />
        </Drawer.Trigger>
        <Drawer.Portal className={styles["drawerPortal"]}>
          <Drawer.Backdrop />
          <Drawer.Viewport>
            <Drawer.Popup>
              <Drawer.Content className={styles["drawerContent"]}>
                <div className={styles["drawerHeader"]}>
                  <Drawer.Title className={styles["drawerTitle"]}>{wiki.title}</Drawer.Title>
                  <Drawer.Close render={<IconButton aria-label="Close the wiki navigation" />}>
                    <CloseIcon />
                  </Drawer.Close>
                </div>
                <WikiNavigation current={current} wiki={wiki} />
                <WikiFooter />
              </Drawer.Content>
            </Drawer.Popup>
          </Drawer.Viewport>
        </Drawer.Portal>
      </Drawer.Root>
    </div>
  );
}
