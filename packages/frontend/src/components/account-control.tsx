import type { AuthenticationStatus } from "@earendil-works/jot-protocol";

import type { ApiClientService } from "../api.ts";
import { LogoutButton } from "./logout-button.tsx";

export interface AccountControlProps {
  readonly account: NonNullable<AuthenticationStatus["principal"]>;
  readonly api: ApiClientService;
}

export function AccountControl({ account, api }: AccountControlProps): React.JSX.Element {
  return (
    <div className="account-control" data-account="">
      <span className="account-control__identity" title={account.email ?? account.displayName}>
        <strong data-account-name="">{account.displayName}</strong>
        {account.email === undefined || account.email === account.displayName ? null : (
          <span data-account-email="">{account.email}</span>
        )}
      </span>
      <LogoutButton api={api} />
    </div>
  );
}
