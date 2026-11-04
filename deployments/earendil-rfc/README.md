# Earendil RFCs deployment

This is Earendil's own Inkling deployment, serving `rfc.earendil.com`. It has the same shape as
the public [`templates/cloudflare`](../../templates/cloudflare) project, except that it depends on
the workspace packages instead of released npm versions, so it always deploys the current
checkout.
`make check` verifies that its Durable Object bindings, migrations, and asset routing stay in
sync with the template and the development Worker.

| Setting           | Value                                                          |
| ----------------- | -------------------------------------------------------------- |
| Cloudflare zone   | `earendil.com` (full setup)                                    |
| Worker            | `earendil-inkling`                                             |
| Hostname          | `rfc.earendil.com` (Worker route, live since 2026-10-22)       |
| R2 buckets        | `earendil-inkling-objects`, `earendil-inkling-objects-preview` |
| Legacy RFC site   | `legacy-rfc.earendil.com`, from `earendil-works/rfcs`          |
| RFC source import | `~/Development/earendil-rfcs`                                  |

## Deploying

Deploys run from the manually dispatched
[`deploy-earendil-rfc.yml`](../../.github/workflows/deploy-earendil-rfc.yml) workflow on `main`.
It builds the frontend and deploys this directory with Wrangler. The workflow runs in the
`earendil-rfc` GitHub environment, which holds:

- secret `CLOUDFLARE_API_TOKEN`: may edit Workers scripts, routes, and custom domains for the
  account and the `earendil.com` zone, and read R2;
- variable `CLOUDFLARE_ACCOUNT_ID`.

Add required reviewers to the environment to gate production deploys.

To deploy from a checkout instead, after `make setup`:

```sh
pnpm build
pnpm deploy:earendil-rfc
```

## One-time setup

1. Create the R2 buckets:

   ```sh
   cd deployments/earendil-rfc
   pnpm exec wrangler r2 bucket create earendil-inkling-objects
   pnpm exec wrangler r2 bucket create earendil-inkling-objects-preview
   ```

2. On the Google OAuth web client, register this redirect URI:

   ```text
   https://rfc.earendil.com/api/auth/google/callback
   ```

3. Store the Worker secrets. `GOOGLE_ALLOWED_DOMAINS` is `earendil.com`; generate the state
   secret with `openssl rand -base64 48`:

   ```sh
   pnpm exec wrangler secret put GOOGLE_CLIENT_ID
   pnpm exec wrangler secret put GOOGLE_CLIENT_SECRET
   pnpm exec wrangler secret put GOOGLE_ALLOWED_DOMAINS
   pnpm exec wrangler secret put GOOGLE_ADMIN_EMAILS
   pnpm exec wrangler secret put INKLING_OAUTH_STATE_SECRET
   ```

   Before the first deploy, Wrangler offers to create the Worker to hold the secrets. Sign-in
   fails closed until they exist.

4. Optional semantic search for agents: create the index and add the `ai` and `vectorize`
   bindings described in the template README to `wrangler.jsonc`.

   ```sh
   pnpm exec wrangler vectorize create earendil-inkling-passages --dimensions=768 --metric=cosine
   ```

## Importing the RFCs

Sign in at `https://rfc.earendil.com` as an administrator, create an API key, then import
from a freshly synced `earendil-rfcs` checkout. The import is incremental and idempotent:

```sh
(cd ~/Development/earendil-rfcs && git pull --ff-only && make sync)
INKLING_URL=https://rfc.earendil.com INKLING_API_KEY=... pnpm import-rfcs --publish
```

## Cutover

The cutover is complete. These steps are kept for reference; the staging hostname
`rfc-next.earendil.com` has been retired.

1. Move the legacy site to `legacy-rfc.earendil.com` in `earendil-works/rfcs`: change
   `BASE_URL`, set `SITE_ORIGIN`, register `https://legacy-rfc.earendil.com/auth/callback` on its
   OAuth client, and replace the `rfc.earendil.com/*` route with a
   `legacy-rfc.earendil.com` custom domain. Merge this before the cutover: that repository
   redeploys on every RFC sync and would otherwise reclaim the route.
2. Freeze edits in Google Docs, sync once more, and rerun the import against `rfc-next`.
3. In the Cloudflare dashboard, reassign the `rfc.earendil.com/*` route to `earendil-inkling`.
   This switches without downtime.
4. Add the route to `wrangler.jsonc` so later deploys keep it:

   ```jsonc
   "routes": [{ "pattern": "rfc.earendil.com/*", "zone_name": "earendil.com" }],
   ```

5. Check that `/0057/` redirects to `/rfc/0057`, Google sign-in works, public RFCs load
   anonymously, private RFCs do not, and `/mcp` answers.
6. Remove `rfc-next.earendil.com` from `wrangler.jsonc` and delete its Custom Domain under the
   Worker's Settings → Domains & Routes (Wrangler does not detach Custom Domains that disappear
   from the config), or redirect it to `rfc.earendil.com` with a Cloudflare redirect rule. Browser sessions and MCP OAuth grants are bound to the hostname, so users sign in
   again and agents reconnect on `rfc.earendil.com`; API keys keep working.
