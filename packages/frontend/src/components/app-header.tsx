import { useEffect, useState } from "react";
import type { CSSProperties } from "react";

import type { PresenceDto } from "@earendil-works/inkling-protocol";

import type { ApiClientService } from "../api.ts";
import type { AppStatus } from "../app-context.tsx";
import { AccountControl } from "./account-control.tsx";
import styles from "./app-header.module.css";
import type { AccountControlProps } from "./account-control.tsx";
import { Button } from "./button.tsx";
import { ButtonLink } from "./button-link.tsx";

export interface BreadcrumbItem {
  readonly href?: string | undefined;
  readonly label: string;
  readonly truncate?: boolean | undefined;
}

export interface AppHeaderProps {
  readonly account: AccountControlProps["account"] | undefined;
  readonly api: ApiClientService | undefined;
  readonly breadcrumbs: readonly BreadcrumbItem[];
  readonly participants: readonly PresenceDto[];
  readonly status: AppStatus | undefined;
}

export function AppHeader({
  account,
  api,
  breadcrumbs,
  participants,
  status,
}: AppHeaderProps): React.JSX.Element {
  const [theme, setTheme] = useState<"dark" | "light">(() =>
    document.documentElement.dataset["theme"] === "dark" ? "dark" : "light",
  );

  useEffect(() => {
    document.documentElement.dataset["theme"] = theme;
    document
      .querySelector<HTMLMetaElement>('meta[name="theme-color"]')
      ?.setAttribute(
        "content",
        getComputedStyle(document.documentElement).getPropertyValue("--page").trim(),
      );
  }, [theme]);

  const toggleTheme = (): void => {
    setTheme((current) => {
      const next = current === "dark" ? "light" : "dark";
      localStorage.setItem("inkling-theme", next);
      return next;
    });
  };

  return (
    <header className={styles["masthead"]}>
      <nav className={styles["breadcrumbs"]} aria-label="Breadcrumb" data-breadcrumbs="">
        <ol>
          {breadcrumbs.map((breadcrumb, index) => {
            const current = index === breadcrumbs.length - 1;
            const className = index === 0 ? styles["wordmark"] : styles["breadcrumbLabel"];
            return (
              <li
                className={breadcrumb.truncate === true ? styles["truncate"] : undefined}
                key={`${index}:${breadcrumb.label}`}
              >
                {index === 0 ? null : (
                  <span className={styles["separator"]} aria-hidden="true">
                    /
                  </span>
                )}
                {breadcrumb.href === undefined ? (
                  <span
                    aria-current={current ? "page" : undefined}
                    className={className}
                    data-breadcrumb=""
                    title={breadcrumb.truncate === true ? breadcrumb.label : undefined}
                  >
                    {breadcrumb.label}
                  </span>
                ) : (
                  <a
                    aria-current={current ? "page" : undefined}
                    aria-label={index === 0 ? "Inkling home" : undefined}
                    className={className}
                    data-breadcrumb=""
                    href={breadcrumb.href}
                    title={breadcrumb.truncate === true ? breadcrumb.label : undefined}
                  >
                    {breadcrumb.label}
                  </a>
                )}
              </li>
            );
          })}
        </ol>
      </nav>
      <div className={styles["right"]}>
        <div
          className={styles["participants"]}
          data-participants=""
          aria-label="Connected participants"
        >
          {participants.map((participant) => (
            <span
              className={styles["participant"]}
              key={participant.participantId}
              style={{ "--participant": participant.color } as CSSProperties}
              title={participant.displayName}
            >
              {participant.displayName.slice(0, 1).toUpperCase()}
            </span>
          ))}
        </div>
        {status === undefined ? null : (
          <div className={styles["apiState"]} role="status" aria-live="polite">
            <span className={styles["apiLight"]} aria-hidden="true" />
            <span data-api-status="">{status.label}</span>
          </div>
        )}
        <Button
          aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
          className={styles["themeToggle"]}
          data-theme-toggle=""
          onClick={(event) => {
            if (event.detail <= 1) toggleTheme();
          }}
          variant="icon"
        >
          <svg aria-hidden="true" viewBox="0 0 16 16">
            <path d="M8 1.75a6.25 6.25 0 0 0 0 12.5Z" fill="currentColor" />
            <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
          </svg>
        </Button>
        {account === undefined ? (
          api === undefined ? null : (
            <ButtonLink
              className={styles["signIn"]}
              data-sign-in=""
              href="/api/auth/google/start"
              size="small"
              variant="primary"
            >
              Sign in
            </ButtonLink>
          )
        ) : api === undefined ? null : (
          <AccountControl account={account} api={api} />
        )}
      </div>
    </header>
  );
}
