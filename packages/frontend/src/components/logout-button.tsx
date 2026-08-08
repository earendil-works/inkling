import type { ApiClientService, ApiError } from "../api.ts";
import { useAppContext } from "../app-context.tsx";
import { useEffectAction } from "../effect-hooks.ts";
import { Button } from "./button.tsx";

export interface LogoutButtonProps {
  readonly api: ApiClientService;
  readonly role?: React.AriaRole | undefined;
}

export function LogoutButton({ api, role }: LogoutButtonProps): React.JSX.Element {
  const { navigate } = useAppContext();
  const logout = useEffectAction<void, void, ApiError>(() => api.logout);

  return (
    <Button
      data-logout=""
      disabled={logout.state.pending}
      onClick={() =>
        logout.execute(undefined, { onSuccess: () => navigate("/", { replace: true }) })
      }
      role={role}
      variant="text"
    >
      {logout.state.pending ? "Signing out…" : "Sign out"}
    </Button>
  );
}
