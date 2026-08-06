import { useState } from "react";

import type { AuthenticationStatus } from "@earendil-works/jot-protocol";

import type { ApiClientService, ApiError } from "./api.ts";
import { useAppContext } from "./app-context.tsx";
import { Button } from "./components/button.tsx";
import { useEffectAction } from "./effect-hooks.ts";

export interface AuthenticationScreenProps {
  readonly api: ApiClientService;
  readonly methods: AuthenticationStatus["authenticationMethods"];
  readonly mode: "login" | "setup";
}

export function AuthenticationScreen({
  api,
  methods,
  mode,
}: AuthenticationScreenProps): React.JSX.Element {
  const { navigate, setStatus } = useAppContext();
  const [password, setPassword] = useState("");
  const authentication = useEffectAction<string, void, ApiError>((value) =>
    mode === "setup" ? api.setup(value) : api.login(value),
  );
  const submit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    authentication.execute(password, {
      onSuccess: () => {
        setStatus({ label: "Workspace connected", state: "ready" });
        navigate("/", { replace: true });
      },
    });
  };

  return (
    <main className="auth-layout" id="app" tabIndex={-1}>
      <section className="auth-copy">
        <p className="eyebrow">
          {mode === "setup" ? "First run / local owner" : "Private workspace"}
        </p>
        <h1>{mode === "setup" ? "Make this workspace yours." : "Continue writing."}</h1>
        <p>
          Jot keeps the working head private, journals every accepted edit, and publishes only
          explicit revisions.
        </p>
      </section>
      <section className="auth-panel" aria-labelledby="auth-title">
        <p className="folio">JOT / AUTHORITY</p>
        <h2 id="auth-title">{mode === "setup" ? "Set owner password" : "Owner sign in"}</h2>
        <form data-auth-form="" onSubmit={submit}>
          {methods.includes("password") ? (
            <>
              <label>
                Password
                <input
                  autoComplete={mode === "setup" ? "new-password" : "current-password"}
                  autoFocus
                  minLength={12}
                  name="password"
                  onChange={(event) => setPassword(event.currentTarget.value)}
                  required
                  type="password"
                  value={password}
                />
              </label>
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
            <a className="primary-button google-button" href="/api/auth/google/start">
              Continue with Google
            </a>
          ) : null}
          <p className="form-error" data-form-error="">
            {authentication.state.error?.message}
          </p>
        </form>
      </section>
    </main>
  );
}
