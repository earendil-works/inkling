# Inkling on Cloudflare

This is a standalone Cloudflare deployment of Inkling. The application code and compiled browser
assets come from pinned npm packages; this repository owns only the deployment configuration.

## Requirements

- Node.js 24 or newer
- pnpm 10 or newer
- A Cloudflare account with Workers, Durable Objects, and R2
- A Google OAuth web client

## Configure the deployment

Choose a Worker name and R2 bucket names in [`wrangler.jsonc`](wrangler.jsonc). The defaults are
`inkling`, `inkling-objects`, and `inkling-objects-preview`. R2 bucket names must not collide with
another deployment in the same Cloudflare account.

Install the pinned dependencies:

```sh
pnpm install --frozen-lockfile
```

Create the R2 buckets named in `wrangler.jsonc`:

```sh
pnpm exec wrangler r2 bucket create inkling-objects
pnpm exec wrangler r2 bucket create inkling-objects-preview
```

## Local development

Copy the development variables and fill in the Google OAuth values:

```sh
cp .dev.vars.example .dev.vars
pnpm dev
```

Register this exact local callback on the Google OAuth client:

```text
http://localhost:8787/api/auth/google/callback
```

Open <http://localhost:8787>. Authentication fails closed when Google OAuth is not configured.
Never commit `.dev.vars`.

## Production secrets

Register `https://<your-host>/api/auth/google/callback` on the Google OAuth client. Then store the
production values as Worker secrets:

```sh
pnpm exec wrangler secret put GOOGLE_CLIENT_ID
pnpm exec wrangler secret put GOOGLE_CLIENT_SECRET
pnpm exec wrangler secret put GOOGLE_ALLOWED_DOMAINS
pnpm exec wrangler secret put GOOGLE_ADMIN_EMAILS
pnpm exec wrangler secret put INKLING_OAUTH_STATE_SECRET
```

`GOOGLE_REDIRECT_URI` is normally inferred from the request host. Store it as another secret when
the public callback origin differs from the Worker origin.

Deploy with:

```sh
pnpm deploy
```

Do not remove or rewrite existing Durable Object migrations in `wrangler.jsonc`. New Inkling
versions may require migrations to be appended during an upgrade.

## Updating Inkling

Update the two `@earendil-works/inkling-*` dependencies together, refresh the lockfile, and verify
the deployment bundle before deploying:

```sh
pnpm update --latest @earendil-works/inkling-frontend \
  @earendil-works/inkling-runtime-cloudflare
pnpm check
```
