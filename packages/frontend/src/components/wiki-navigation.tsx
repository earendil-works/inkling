import { useState } from "react";

import { SideNavigation, TopNavigation } from "@earendil-works/elanor-react";

import { containsWikiPath } from "../wiki-navigation.ts";
import type {
  WikiNavigation as WikiNavigationData,
  WikiNavigationItem,
} from "../wiki-navigation.ts";
import styles from "./wiki-navigation.module.css";

/*
 * The wiki's navigation, rendered twice from the same data like pi.dev's
 * docs: as the side navigation on wide screens, and as the top bar's menu on
 * narrow ones. A section opens on the pages inside it; one the reader opens
 * or closes stays that way while they browse the wiki.
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

/** Opens as the reader left it; otherwise on the pages inside it. */
function useSectionOpen(
  key: string,
  items: readonly WikiNavigationItem[],
  current: string,
): readonly [boolean, (open: boolean) => void] {
  const [, setChanges] = useState(0);
  const open = (remembers ? sectionStates.get(key) : undefined) ?? containsWikiPath(items, current);
  return [
    open,
    (next) => {
      if (remembers) sectionStates.set(key, next);
      setChanges((count) => count + 1);
    },
  ];
}

/** The side navigation: each group under its heading, with its pages and sections. */
export function WikiNavigation({ wiki, current }: WikiNavigationProps): React.JSX.Element {
  return (
    <SideNavigation.Root aria-label="Wiki" data-wiki-navigation="">
      {wiki.groups.map((group, index) => {
        const labelId = `wiki-navigation-group-${index}`;
        return (
          <SideNavigation.Group key={`${group.label ?? ""}:${index}`}>
            {group.label === undefined ? null : (
              <SideNavigation.GroupLabel id={labelId}>{group.label}</SideNavigation.GroupLabel>
            )}
            <SideList
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

function SideList({
  className,
  current,
  items,
  labelledBy,
  path,
}: {
  readonly className?: string | undefined;
  readonly current: string;
  readonly items: readonly WikiNavigationItem[];
  readonly labelledBy?: string | undefined;
  readonly path: string;
}): React.JSX.Element {
  return (
    <SideNavigation.List aria-labelledby={labelledBy} className={className}>
      {items.map((item, index) => {
        const itemPath = `${path}/${index}`;
        return item.kind === "section" ? (
          <SideNavigation.Item key={itemPath}>
            <SideSection current={current} item={item} path={itemPath} />
          </SideNavigation.Item>
        ) : (
          <SideNavigation.Item key={itemPath}>
            <SideNavigation.Link active={item.href === current} href={item.href}>
              {item.label}
            </SideNavigation.Link>
            {item.items.length === 0 ? null : (
              <SideList
                className={styles["nested"]}
                current={current}
                items={item.items}
                path={itemPath}
              />
            )}
          </SideNavigation.Item>
        );
      })}
    </SideNavigation.List>
  );
}

function SideSection({
  current,
  item,
  path,
}: {
  readonly current: string;
  readonly item: WikiNavigationItem;
  readonly path: string;
}): React.JSX.Element {
  const [open, setOpen] = useSectionOpen(`${path}:${item.label}`, item.items, current);
  return (
    <SideNavigation.Collapsible onOpenChange={setOpen} open={open}>
      <SideNavigation.CollapsibleTrigger>{item.label}</SideNavigation.CollapsibleTrigger>
      <SideNavigation.CollapsiblePanel>
        <SideList current={current} items={item.items} path={path} />
      </SideNavigation.CollapsiblePanel>
    </SideNavigation.Collapsible>
  );
}

/** The top bar's menu: the same groups, pages, and sections. */
export function WikiMenuNavigation({ wiki, current }: WikiNavigationProps): React.JSX.Element {
  return (
    <>
      {wiki.groups.map((group, index) =>
        group.label === undefined ? (
          <MenuList current={current} items={group.items} key={index} path={String(index)} />
        ) : (
          <TopNavigation.MenuGroup key={`${group.label}:${index}`}>
            <TopNavigation.MenuGroupLabel>{group.label}</TopNavigation.MenuGroupLabel>
            <MenuList current={current} items={group.items} path={String(index)} />
          </TopNavigation.MenuGroup>
        ),
      )}
    </>
  );
}

function MenuList({
  className,
  current,
  items,
  path,
}: {
  readonly className?: string | undefined;
  readonly current: string;
  readonly items: readonly WikiNavigationItem[];
  readonly path: string;
}): React.JSX.Element {
  return (
    <TopNavigation.MenuList className={className}>
      {items.map((item, index) => {
        const itemPath = `${path}/${index}`;
        return item.kind === "section" ? (
          <TopNavigation.MenuItem key={itemPath}>
            <MenuSection current={current} item={item} path={itemPath} />
          </TopNavigation.MenuItem>
        ) : (
          <TopNavigation.MenuItem key={itemPath}>
            <TopNavigation.MenuLink active={item.href === current} href={item.href}>
              {item.label}
            </TopNavigation.MenuLink>
            {item.items.length === 0 ? null : (
              <MenuList
                className={styles["nestedMenu"]}
                current={current}
                items={item.items}
                path={itemPath}
              />
            )}
          </TopNavigation.MenuItem>
        );
      })}
    </TopNavigation.MenuList>
  );
}

function MenuSection({
  current,
  item,
  path,
}: {
  readonly current: string;
  readonly item: WikiNavigationItem;
  readonly path: string;
}): React.JSX.Element {
  const [open, setOpen] = useSectionOpen(`${path}:${item.label}`, item.items, current);
  return (
    <TopNavigation.MenuCollapsible onOpenChange={setOpen} open={open}>
      <TopNavigation.MenuCollapsibleTrigger>{item.label}</TopNavigation.MenuCollapsibleTrigger>
      <TopNavigation.MenuCollapsiblePanel>
        <MenuList current={current} items={item.items} path={path} />
      </TopNavigation.MenuCollapsiblePanel>
    </TopNavigation.MenuCollapsible>
  );
}
