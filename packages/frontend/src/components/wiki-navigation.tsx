import { useEffect, useState } from "react";

import { CloseIcon, MenuIcon } from "@earendil-works/elanor-icons-react";
import { Button, Drawer, IconButton, SideNavigation, Stack } from "@earendil-works/elanor-react";

import { WIKI_PATH } from "../ui.ts";
import { containsWikiPath } from "../wiki-navigation.ts";
import type {
  WikiNavigation as WikiNavigationData,
  WikiNavigationItem,
} from "../wiki-navigation.ts";
import styles from "./wiki-navigation.module.css";

/*
 * The wiki's navigation beside a wiki page, like pi.dev's documentation rail:
 * the index first, then its groups, with sections that fold. A section opens
 * on the pages inside it; one the reader opens or closes stays that way while
 * they browse the wiki.
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

/** The navigation as a side navigation, for the aside on wide screens. */
export function WikiNavigation({ wiki, current }: WikiNavigationProps): React.JSX.Element {
  return (
    <SideNavigation.Root aria-label="Wiki" className={styles["navigation"]} data-wiki-navigation="">
      <SideNavigation.Group>
        <SideNavigation.List>
          <SideNavigation.Item>
            <SideNavigation.Link active={current === WIKI_PATH} data-wiki-index="" href={WIKI_PATH}>
              {wiki.title}
            </SideNavigation.Link>
          </SideNavigation.Item>
        </SideNavigation.List>
      </SideNavigation.Group>
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

/**
 * The navigation in a side panel on narrow screens, where the aside leaves:
 * a button above the page opens it, and it closes when the reader moves on.
 */
export function WikiNavigationDrawer({ wiki, current }: WikiNavigationProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [current]);
  // The button only shows below the wide layout; an open panel closes rather than hides there.
  useEffect(() => {
    const wide = matchMedia("(width >= 64rem)");
    const close = () => {
      if (wide.matches) setOpen(false);
    };
    wide.addEventListener("change", close);
    return () => wide.removeEventListener("change", close);
  }, []);
  return (
    <Drawer.Root onOpenChange={setOpen} open={open} swipeDirection="left">
      <Drawer.Trigger
        render={
          <Button
            className={styles["drawerTrigger"]}
            data-wiki-navigation-trigger=""
            hierarchy="secondary"
            iconStart={<MenuIcon />}
          />
        }
      >
        {wiki.title}
      </Drawer.Trigger>
      <Drawer.Portal className={styles["drawerPortal"]}>
        <Drawer.Backdrop />
        <Drawer.Viewport>
          <Drawer.Popup>
            <Drawer.Content>
              <Stack align="stretch" gap="large">
                <Stack align="center" direction="row" gap="auto">
                  <Drawer.Title>{wiki.title}</Drawer.Title>
                  <Drawer.Close render={<IconButton aria-label="Close the wiki navigation" />}>
                    <CloseIcon />
                  </Drawer.Close>
                </Stack>
                <WikiNavigation current={current} wiki={wiki} />
              </Stack>
            </Drawer.Content>
          </Drawer.Popup>
        </Drawer.Viewport>
      </Drawer.Portal>
    </Drawer.Root>
  );
}
