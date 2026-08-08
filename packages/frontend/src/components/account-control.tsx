import { useEffect, useRef, useState } from "react";

import type { AuthenticationStatus } from "@earendil-works/jot-protocol";

import type { ApiClientService } from "../api.ts";
import { Button } from "./button.tsx";
import { LogoutButton } from "./logout-button.tsx";
import { SettingsDialog } from "./settings-dialog.tsx";

export interface AccountControlProps {
  readonly account: NonNullable<AuthenticationStatus["principal"]>;
  readonly api: ApiClientService;
}

export function AccountControl({ account, api }: AccountControlProps): React.JSX.Element {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [apiKeysOpen, setApiKeysOpen] = useState(false);
  const accountName = account.displayName.trim() || account.email?.trim() || "Account";

  useEffect(() => {
    if (!menuOpen) return;
    const dismiss = (event: PointerEvent): void => {
      if (!detailsRef.current?.contains(event.target as Node))
        detailsRef.current?.removeAttribute("open");
    };
    const dismissWithKeyboard = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      detailsRef.current?.removeAttribute("open");
      detailsRef.current?.querySelector<HTMLElement>("summary")?.focus();
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", dismissWithKeyboard);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", dismissWithKeyboard);
    };
  }, [menuOpen]);

  const closeMenu = (): void => {
    detailsRef.current?.removeAttribute("open");
  };

  return (
    <>
      <details
        className="account-control"
        data-account=""
        onToggle={(event) => setMenuOpen(event.currentTarget.open)}
        ref={detailsRef}
      >
        <summary
          aria-haspopup="menu"
          className="account-control__trigger"
          title={account.email ?? accountName}
        >
          <strong data-account-name="">{accountName}</strong>
          <svg aria-hidden="true" viewBox="0 0 12 12">
            <path d="m3 4.5 3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.4" />
          </svg>
        </summary>
        <div className="account-menu" data-account-menu="" role="menu">
          <Button
            data-open-api-keys=""
            onClick={() => {
              closeMenu();
              setApiKeysOpen(true);
            }}
            role="menuitem"
            variant="text"
          >
            API keys
          </Button>
          <LogoutButton api={api} role="menuitem" />
        </div>
      </details>
      {apiKeysOpen ? (
        <SettingsDialog accountName={accountName} api={api} onClose={() => setApiKeysOpen(false)} />
      ) : null}
    </>
  );
}
