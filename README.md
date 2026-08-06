# Jot

Jot is a collaborative Markdown workspace. The current development and hosted configuration uses mandatory Google sign-in on the Cloudflare runtime.

## Development

Install dependencies and create the local Cloudflare configuration:

```sh
pnpm install
cp packages/runtime-cloudflare/.dev.vars.example packages/runtime-cloudflare/.dev.vars
```

Fill in `packages/runtime-cloudflare/.dev.vars`:

```dotenv
GOOGLE_CLIENT_ID=your-web-client-id
GOOGLE_CLIENT_SECRET=your-web-client-secret
GOOGLE_ALLOWED_DOMAINS=example.com,example.org
GOOGLE_ADMIN_EMAILS=admin@example.com
GOOGLE_REDIRECT_URI=http://localhost:5173/api/auth/google/callback
JOT_OAUTH_STATE_SECRET=a-long-random-value
```

Then start Vite and the Cloudflare development runtime:

```sh
pnpm dev
```

Open <http://localhost:5173>. Google authentication is mandatory: the Cloudflare runtime does not offer password setup or password sign-in, and it fails closed when OAuth is not configured.

`.dev.vars` is ignored by Git. Never commit OAuth client secrets or the state-signing secret.

### Authentication settings

- `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` identify the Google OAuth web client.
- `GOOGLE_ALLOWED_DOMAINS` is a comma-separated allowlist. Jot checks the exact domain of Google's verified email claim; Google's hosted-domain hint is not treated as authorization.
- `GOOGLE_ADMIN_EMAILS` is a comma-separated list of allowed users who may administer the workspace and API keys. Other allowed users become workspace members.
- `GOOGLE_REDIRECT_URI` must exactly match an authorized redirect URI on the OAuth client.
- `JOT_OAUTH_STATE_SECRET` signs short-lived OAuth state. Generate an independent value with `openssl rand -base64 48`.

## Create Google OAuth credentials

Google's current setup is under **Google Auth Platform** in the [Google Cloud Console](https://console.cloud.google.com/auth/overview):

1. Select an existing Google Cloud project or create one.
2. Open **Google Auth Platform → Branding** and configure the application name, support email, and developer contact information.
3. Open **Audience**. For a Google Workspace organization, choose **Internal** when the app should only be available within that organization. Otherwise choose **External** and add test users while the app remains in testing.
4. Review **Data Access**. Jot requests only `openid`, `email`, and `profile` for sign-in.
5. Open **Clients**, choose **Create client**, and select **Web application**.
6. Add the exact local redirect URI:

   ```text
   http://localhost:5173/api/auth/google/callback
   ```

7. Add the production callback as another authorized redirect URI, replacing the hostname with the deployed Jot hostname:

   ```text
   https://jot.example.com/api/auth/google/callback
   ```

8. Create the client and immediately save its client ID and client secret. Google may show a newly created client secret only once.
9. Put those values in `.dev.vars` for local development or in Cloudflare Worker secrets for production.

Jot uses a server-side authorization-code flow with PKCE, so no Authorized JavaScript Origin is required for its authentication flow. Redirect URI matching is exact, including scheme, host, port, path, and trailing slash.

Official references:

- [Using OAuth 2.0 for Web Server Applications](https://developers.google.com/identity/protocols/oauth2/web-server)
- [Configure the OAuth consent screen](https://developers.google.com/workspace/guides/configure-oauth-consent)
- [Manage OAuth clients](https://support.google.com/cloud/answer/15549257)

## Production secrets

Register the production callback in Google Cloud Console, then configure the Worker from `packages/runtime-cloudflare`:

```sh
cd packages/runtime-cloudflare
pnpm exec wrangler secret put GOOGLE_CLIENT_ID
pnpm exec wrangler secret put GOOGLE_CLIENT_SECRET
pnpm exec wrangler secret put GOOGLE_ALLOWED_DOMAINS
pnpm exec wrangler secret put GOOGLE_ADMIN_EMAILS
pnpm exec wrangler secret put JOT_OAUTH_STATE_SECRET
```

`GOOGLE_REDIRECT_URI` is optional in production. When omitted, Jot derives it as `https://<request-host>/api/auth/google/callback`; that derived URI must be registered on the Google OAuth client. Set it explicitly with `wrangler secret put GOOGLE_REDIRECT_URI` when requests reach Jot through a different public origin.

Deploy with:

```sh
pnpm run build
pnpm --filter @earendil-works/jot-runtime-cloudflare run deploy
```

## Checks

```sh
make check
```
