import { useEffect, useState } from "react";
import type { CSSProperties } from "react";

import type { PresenceDto } from "@earendil-works/jot-protocol";

import type { ApiClientService } from "../api.ts";
import type { AppStatus } from "../app-context.tsx";
import { AccountControl } from "./account-control.tsx";
import type { AccountControlProps } from "./account-control.tsx";
import { Button } from "./button.tsx";
import { ButtonLink } from "./button-link.tsx";

export interface AppHeaderProps {
  readonly account: AccountControlProps["account"] | undefined;
  readonly api: ApiClientService | undefined;
  readonly participants: readonly PresenceDto[];
  readonly status: AppStatus | undefined;
}

export function AppHeader({
  account,
  api,
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
      ?.setAttribute("content", theme === "dark" ? "#2e2d2b" : "#faf9f6");
  }, [theme]);

  const toggleTheme = (): void => {
    setTheme((current) => {
      const next = current === "dark" ? "light" : "dark";
      localStorage.setItem("jot-theme", next);
      return next;
    });
  };

  return (
    <header className="masthead">
      <a className="wordmark" href="/" aria-label="Notes and RFCs home">
        Notes and RFCs
      </a>
      <div className="masthead__right">
        <div className="participants" data-participants="" aria-label="Connected participants">
          {participants.map((participant) => (
            <span
              className="participant"
              key={participant.participantId}
              style={{ "--participant": participant.color } as CSSProperties}
              title={participant.displayName}
            >
              {participant.displayName.slice(0, 1).toUpperCase()}
            </span>
          ))}
        </div>
        {status === undefined ? null : (
          <div className="api-state" role="status" aria-live="polite">
            <span className="api-state__light" aria-hidden="true" />
            <span data-api-status="">{status.label}</span>
          </div>
        )}
        <Button
          aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
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
              className="masthead-sign-in"
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
