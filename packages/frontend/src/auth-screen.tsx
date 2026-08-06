import type { AuthenticationStatus } from "@earendil-works/jot-protocol";

import type { ApiClientService } from "./api.ts";
import { AuthenticationForm } from "./components/authentication-form.tsx";

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
      <AuthenticationForm api={api} methods={methods} mode={mode} />
    </main>
  );
}
