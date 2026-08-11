# Deploying Inkling

Inkling supports two runtimes:

- A self-contained Node.js service backed by the filesystem.
- A Cloudflare Worker backed by Durable Objects and R2.

## Requirements

- Node.js 24 or newer
- pnpm 10 or newer

Install dependencies with:

```sh
pnpm install
```

## Cloudflare development

The primary development setup runs Vite on port 5173 and the Cloudflare Worker on port 8787. Copy the example OAuth configuration first:

```sh
cp packages/runtime-cloudflare/.dev.vars.example packages/runtime-cloudflare/.dev.vars
```

Configure `packages/runtime-cloudflare/.dev.vars`:

```dotenv
GOOGLE_CLIENT_ID=your-web-client-id
GOOGLE_CLIENT_SECRET=your-web-client-secret
GOOGLE_ALLOWED_DOMAINS=example.com,example.org
GOOGLE_ADMIN_EMAILS=admin@example.com
GOOGLE_REDIRECT_URI=http://localhost:5173/api/auth/google/callback
INKLING_OAUTH_STATE_SECRET=a-long-random-value
```

Then start both processes:

```sh
pnpm dev
```

Open <http://localhost:5173>. Vite proxies API and WebSocket traffic to the Worker. Google authentication is mandatory in the Cloudflare runtime; it fails closed when OAuth is not configured.

`.dev.vars` is ignored by Git. Never commit OAuth client secrets or state-signing secrets.

### Authentication settings

- `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` identify the Google OAuth web client.
- `GOOGLE_ALLOWED_DOMAINS` is a comma-separated allowlist. Inkling checks the exact domain of Google's verified email claim; Google's hosted-domain hint is not treated as authorization.
- `GOOGLE_ADMIN_EMAILS` is a comma-separated list of allowed users who may administer the workspace. Other allowed users become workspace members. Every user manages their own API keys, which inherit that user's role.
- `GOOGLE_REDIRECT_URI` must exactly match an authorized redirect URI on the OAuth client.
- `INKLING_OAUTH_STATE_SECRET` signs short-lived OAuth state. It is optional and falls back to `GOOGLE_CLIENT_SECRET`, but a separate value generated with `openssl rand -base64 48` is recommended.

### Create Google OAuth credentials

Google's current setup is under **Google Auth Platform** in the [Google Cloud Console](https://console.cloud.google.com/auth/overview):

1. Select an existing Google Cloud project or create one.
2. Open **Google Auth Platform → Branding** and configure the application name, support email, and developer contact information.
3. Open **Audience**. For a Google Workspace organization, choose **Internal** when the app should only be available within that organization. Otherwise choose **External** and add test users while the app remains in testing.
4. Review **Data Access**. Sign-in requests `openid`, `email`, and `profile`. The server may also request read-only directory access to resolve workspace display names and aliases.
5. Open **Clients**, choose **Create client**, and select **Web application**.
6. Add the local redirect URI:

   ```text
   http://localhost:5173/api/auth/google/callback
   ```

7. Add the production callback, replacing the hostname with the deployed Inkling hostname:

   ```text
   https://rfcs.example.com/api/auth/google/callback
   ```

8. Create the client and save its client ID and client secret.
9. Put those values in `.dev.vars` for local development or in Cloudflare Worker secrets for production.

Inkling uses a server-side authorization-code flow with PKCE, so no Authorized JavaScript Origin is required for authentication. Redirect URI matching is exact, including scheme, host, port, path, and trailing slash.

### Theme configuration

Inkling ships with two complete themes: [`inkling`](themes/inkling.json), the default editorial palette, and [`paper`](themes/paper.json), a warmer paper-colored palette with its own fonts. Every color—including editor syntax, status chips, presence colors, overlays, and Mermaid diagrams—is expressed in OKLCH. [`theme.schema.json`](theme.schema.json) documents the format.

Select a theme with `INKLING_THEME`:

- Leave it unset or set it to `default` or `inkling` to use the default theme.
- Set it to `paper` to use the bundled paper theme.
- In the Node.js runtime, a value other than a bundled name can be a JSON file path. Relative paths are resolved from the process working directory. Inline JSON is also accepted.
- In the Cloudflare runtime, custom themes must be supplied as complete inline JSON because Workers cannot read deployment-local files.

For the normal Cloudflare and Vite development servers:

```sh
INKLING_THEME=paper make dev
```

For local Node development:

```sh
INKLING_THEME=paper pnpm --filter @earendil-works/inkling-runtime-node start

# Or customize a bundled theme.
cp themes/inkling.json my-theme.json
INKLING_THEME=./my-theme.json pnpm --filter @earendil-works/inkling-runtime-node start
```

For Cloudflare, set `INKLING_THEME=paper` as a text variable for the bundled theme, or upload custom JSON as a secret:

```sh
cd packages/runtime-cloudflare
pnpm exec wrangler secret put INKLING_THEME < ../../my-theme.json
```

Themes must include both `light` and `dark`. Font imports must be HTTPS URLs, and all color values must use `oklch(...)`; invalid themes fail instead of injecting partial CSS.

Official references:

- [Using OAuth 2.0 for Web Server Applications](https://developers.google.com/identity/protocols/oauth2/web-server)
- [Configure the OAuth consent screen](https://developers.google.com/workspace/guides/configure-oauth-consent)
- [Manage OAuth clients](https://support.google.com/cloud/answer/15549257)

## Local Node.js runtime

The Node.js runtime uses a filesystem data directory and the same allowed-domain Google authentication as the Cloudflare deployment. It does not require Cloudflare.

Build the frontend and start the server:

```sh
pnpm --filter @earendil-works/inkling-frontend build
pnpm --filter @earendil-works/inkling-runtime-node start
```

Configure the Google OAuth environment variables described above, including `GOOGLE_REDIRECT_URI=http://localhost:8787/api/auth/google/callback`, then open <http://localhost:8787> and sign in. The server stores its data in `.inkling` by default and permits only one process to use a data directory at a time.

Configure it with:

- `PORT` — listening port, default `8787`.
- `INKLING_DATA_DIR` — data directory, default `.inkling` in the current directory.

The CLI can also launch the local runtime:

```sh
node packages/cli/src/main.ts serve --port 8787 --data-dir .inkling
```

### Docker

The Docker image runs the same local runtime. Mount the complete `/data` directory for persistence:

```sh
docker build -t inkling .
docker run --rm -p 8787:8787 -v inkling-data:/data inkling
```

## Cloudflare deployment

The Cloudflare runtime uses one Durable Object per document, a workspace Durable Object for the catalog and RFC number allocation, and a private R2 bucket for checkpoints, publications, attachments, and exports.

Register the production callback in Google Cloud Console, then configure secrets from `packages/runtime-cloudflare`:

```sh
cd packages/runtime-cloudflare
pnpm exec wrangler secret put GOOGLE_CLIENT_ID
pnpm exec wrangler secret put GOOGLE_CLIENT_SECRET
pnpm exec wrangler secret put GOOGLE_ALLOWED_DOMAINS
pnpm exec wrangler secret put GOOGLE_ADMIN_EMAILS
pnpm exec wrangler secret put INKLING_OAUTH_STATE_SECRET
```

`GOOGLE_REDIRECT_URI` is optional in production. When omitted, Inkling derives it as `https://<request-host>/api/auth/google/callback`; that URI must be registered on the OAuth client. Set it explicitly with `wrangler secret put GOOGLE_REDIRECT_URI` when requests reach the Worker through a different public origin.

Build and deploy from the repository root:

```sh
pnpm build
pnpm --filter @earendil-works/inkling-runtime-cloudflare deploy
```

The R2 bucket names and Durable Object bindings are declared in [`packages/runtime-cloudflare/wrangler.jsonc`](packages/runtime-cloudflare/wrangler.jsonc).

## Development checks

Run the full formatting, lint, typecheck, test, and build suite with:

```sh
make check
```

Apply automatic formatting with:

```sh
make format
```
