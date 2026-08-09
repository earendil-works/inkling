import { useState } from "react";

import type { ApiClientService, ApiError } from "../api.ts";
import { useEffectAction } from "../effect-hooks.ts";
import { Button } from "./button.tsx";
import { FormError } from "./form-error.tsx";
import styles from "./share-password-screen.module.css";
import { TextField } from "./text-field.tsx";

export function SharePasswordScreen({
  api,
  documentId,
  onUnlocked,
}: {
  readonly api: ApiClientService;
  readonly documentId: string;
  readonly onUnlocked: () => void;
}): React.JSX.Element {
  const [password, setPassword] = useState("");
  const unlock = useEffectAction<string, { readonly unlocked: true }, ApiError>((value) =>
    api.unlockShareLink(documentId, value),
  );

  return (
    <main className={styles["layout"]} data-share-password-screen="" id="app" tabIndex={-1}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (password === "") return;
          unlock.execute(password, { onSuccess: onUnlocked });
        }}
      >
        <p className={styles["eyebrow"]}>Protected share</p>
        <h1>Password required</h1>
        <p>Enter the password supplied by the person who shared this document.</p>
        <TextField
          autoComplete="current-password"
          autoFocus
          label="Password"
          onChange={(event) => setPassword(event.currentTarget.value)}
          required
          type="password"
          value={password}
        />
        <Button disabled={unlock.state.pending} type="submit" variant="primary">
          {unlock.state.pending ? "Opening…" : "Open document"}
        </Button>
        <FormError>{unlock.state.error?.message}</FormError>
      </form>
    </main>
  );
}
