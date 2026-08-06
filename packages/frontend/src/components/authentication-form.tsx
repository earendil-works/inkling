import { useState } from "react";

import type { AuthenticationStatus } from "@earendil-works/jot-protocol";

import type { ApiClientService, ApiError } from "../api.ts";
import { useAppContext } from "../app-context.tsx";
import { useEffectAction } from "../effect-hooks.ts";
import { ButtonLink } from "./button-link.tsx";
import { Button } from "./button.tsx";
import { FormError } from "./form-error.tsx";
import { TextField } from "./text-field.tsx";

export interface AuthenticationFormProps {
  readonly api: ApiClientService;
  readonly methods: AuthenticationStatus["authenticationMethods"];
  readonly mode: "login" | "setup";
}

export function AuthenticationForm({
  api,
  methods,
  mode,
}: AuthenticationFormProps): React.JSX.Element {
  const { navigate, setStatus } = useAppContext();
  const [password, setPassword] = useState("");
  const authentication = useEffectAction<string, void, ApiError>((value) =>
    mode === "setup" ? api.setup(value) : api.login(value),
  );

  return (
    <section className="auth-panel" aria-labelledby="auth-title">
      <p className="folio">JOT / AUTHORITY</p>
      <h2 id="auth-title">{mode === "setup" ? "Set owner password" : "Owner sign in"}</h2>
      <form
        data-auth-form=""
        onSubmit={(event) => {
          event.preventDefault();
          authentication.execute(password, {
            onSuccess: () => {
              setStatus({ label: "Workspace connected", state: "ready" });
              navigate("/", { replace: true });
            },
          });
        }}
      >
        {methods.includes("password") ? (
          <>
            <TextField
              autoComplete={mode === "setup" ? "new-password" : "current-password"}
              autoFocus
              label="Password"
              minLength={12}
              name="password"
              onChange={(event) => setPassword(event.currentTarget.value)}
              required
              type="password"
              value={password}
            />
            <Button variant="primary" disabled={authentication.state.pending} type="submit">
              {authentication.state.pending
                ? "Connecting…"
                : mode === "setup"
                  ? "Initialize workspace"
                  : "Sign in"}
            </Button>
          </>
        ) : null}
        {methods.includes("google") ? (
          <ButtonLink className="google-button" href="/api/auth/google/start" variant="primary">
            Continue with Google
          </ButtonLink>
        ) : null}
        <FormError data-form-error="">{authentication.state.error?.message}</FormError>
      </form>
    </section>
  );
}
