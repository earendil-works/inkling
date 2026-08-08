import { ButtonLink } from "./components/button-link.tsx";

export function AuthenticationScreen(): React.JSX.Element {
  return (
    <main className="auth-layout" id="app" tabIndex={-1}>
      <section className="auth-copy">
        <p className="eyebrow">Private workspace</p>
        <h1>Continue writing.</h1>
        <p>Jot is a collaborative place to write and discuss.</p>
      </section>
      <section className="auth-panel" aria-labelledby="auth-title">
        <p className="folio">JOT / AUTHORITY</p>
        <h2 id="auth-title">Sign in to Jot</h2>
        <ButtonLink className="google-button" href="/api/auth/google/start" variant="primary">
          Continue with Google
        </ButtonLink>
      </section>
    </main>
  );
}
