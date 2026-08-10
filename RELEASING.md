# Releasing Inkling packages

Inkling publishes every package under `packages/` as one fixed-version public release. The manually dispatched `.github/workflows/release.yml` workflow accepts the version, updates every package, and publishes from GitHub Actions with npm trusted publishing. No npm token is stored in GitHub.

## One-time npm bootstrap

npm currently requires a package to exist before trusted publishing can be configured. Before the first supported release, prime the names with empty `0.0.0` placeholders:

1. Ensure the `@earendil-works` npm organization exists and your npm account can publish public packages in it.
2. Create a short-lived granular npm token with read/write access to the `@earendil-works` scope. Use the shortest expiration and enable publishing without an interactive OTP if the organization requires publishing 2FA.
3. From this checkout, run:

   ```sh
   read -s NPM_TOKEN
   export NPM_TOKEN
   pnpm release:prime
   unset NPM_TOKEN
   ```

   The script skips names that already exist and publishes only empty `0.0.0` placeholders. Revoke the token immediately afterwards.

## Configure trusted publishing

The release job uses these exact npm trusted-publisher claims:

- Provider: GitHub Actions
- Organization: `earendil-works`
- Repository: `inkling`
- Workflow filename: `release.yml`
- Environment: `npm`
- Allowed action: `npm publish`

npm 11.15.0 or newer can configure all packages interactively. This requires an npm login with account-level 2FA; granular tokens cannot configure trust:

```sh
npm install --global npm@11.15.0
npm login
pnpm release:trust
```

Alternatively, configure those values under **Trusted Publisher** on each package's npm access page. The workflow filename is only the filename, not `.github/workflows/release.yml`.

Do not dispatch the first release until every package has its trusted publisher configured. After the first OIDC release succeeds, set each package's npm **Publishing access** to **Require two-factor authentication and disallow tokens**.

## Normal releases

Choose the next stable semantic version and dispatch the workflow from `main`:

```sh
gh workflow run release.yml --ref main -f version=0.1.0
```

The version must be `major.minor.patch` and cannot be older than the current package version. The workflow runs all checks, writes that version to every publishable package, commits it directly to `main`, publishes the packages with OIDC provenance, and creates one `v<version>` tag and GitHub release.

A failed partial publish can be resumed by dispatching the same version again; already-published package versions are skipped.

Validate the publishable tarballs locally without publishing:

```sh
pnpm release:pack
```
