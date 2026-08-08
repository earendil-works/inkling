# Inkling

Inkling is a collaborative Markdown workspace for drafting, reviewing, and publishing RFCs. It supports numbered RFCs as well as unnumbered notes, with multiplayer editing, threaded comments, capability sharing, full-text search, and an agent-friendly CLI.

Inkling was previously developed under the working name **Jot**. The Inkling name now applies to its packages, command-line executable, environment variables, API headers, and default on-disk paths.

## Features

- CodeMirror and Yjs-based collaborative Markdown editing with participant cursors and selections.
- Inline threaded comments anchored to collaborative text positions.
- Explicit publication of immutable revisions, separate from the live working head.
- Monotonic RFC number allocation and canonical routes such as `/rfcs/0042`.
- A public landing page for published notes and RFCs, with workspace, confidential, and capability-shared documents kept behind their respective access policies.
- Markdown preview and publication with tables, task lists, syntax highlighting, Mermaid diagrams, stable heading links, and tables of contents.
- Search across complete document bodies, RFC metadata, labels, lifecycle states, and people.
- API keys and a CLI for people, coding agents, imports, backups, verification, and repair.
- A self-contained Node.js runtime backed by the filesystem and a Cloudflare runtime backed by Durable Objects and R2.

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

## Writing and publishing RFCs

The first top-level Markdown heading is the document title. Publication metadata lives in YAML frontmatter at the beginning of the collaborative source:

```yaml
---
authors:
  - author@example.com
state: discussion
visibility: workspace
sensitivity: normal
labels:
  - architecture
  - platform
---
# Durable document checkpoints
```

The editor omits frontmatter and the title heading from rendered prose and reflects valid frontmatter immediately in the live preview. Known author emails resolve through the workspace people directory; unknown addresses display as written.

Frontmatter does not itself change authorization or publish a working draft. An authorized user must explicitly publish, which validates the frontmatter and promotes it into the structured metadata of an immutable published revision. RFC allocation, sharing, and publication remain explicit controls.

Public numbered RFCs use zero-padded canonical routes such as `/rfcs/0042`. Legacy `/rfc/...` routes and old slugged routes redirect to the canonical route. The landing page lists every public published RFC and unnumbered note without requiring sign-in. Anonymous readers can access only those published revisions; editing always uses the authorized working head.

## Search

Press `/` or <kbd>Cmd/Ctrl</kbd>+<kbd>K</kbd> from the workspace to focus search. Plain terms search titles, complete working-head bodies, RFC numbers, labels, states, and people. Terms are combined with AND; quote a phrase to keep it together and prefix a term or filter with `-` to exclude it.

Search supports Gmail-style filters:

| Filter                    | Example                                                                     |
| ------------------------- | --------------------------------------------------------------------------- |
| Label                     | `label:platform` or `tag:"machine learning"`                                |
| Lifecycle state           | `state:discussion`                                                          |
| Visibility or sensitivity | `visibility:workspace sensitivity:confidential`                             |
| People                    | `author:name@example.com`, `reviewer:alex`, `approver:sam`, or `person:lee` |
| RFC number                | `rfc:42`                                                                    |
| Document kind             | `is:rfc`, `is:note`, `is:published`, or `is:unpublished`                    |
| Presence                  | `has:rfc` or `has:publication`                                              |

For example:

```text
label:platform state:discussion "durable checkpoint" -sensitivity:confidential
```

Search reads a derived workspace catalog rather than loading every document authority. The catalog can be rebuilt from authoritative checkpoints.

## CLI and agent access

The command-line executable is named `inkling`. Run it directly from a checkout with:

```sh
node packages/cli/src/main.ts --help
```

Open the account menu and choose **API keys**. Create and copy a personal key; it is revealed only once. Then register the workspace without putting the key in project files:

```sh
inkling instance add workspace https://rfcs.example.com API_KEY
inkling use workspace
inkling list
inkling search 'state:discussion label:platform'
inkling read DOCUMENT_ID
inkling create 'New proposal' --rfc
```

The CLI supports safe unique-text edits, line-range reads, metadata and publication commands, sharing, threaded comments, attachments, imports, backups, restore, verification, and catalog repair. Capability URLs can be registered with `inkling share-instance` for document-scoped access.

Each deployment also serves an origin-aware [`/AGENTS.md`](http://localhost:8787/AGENTS.md). Point a coding agent at that URL for current CLI setup, safe editing guidance, and a reusable Agent Skills template. The served instructions never contain credentials.

Set `INKLING_CONFIG` to override the CLI configuration path, `INKLING_INSTANCE` to override the active instance, and `INKLING_AUTHOR` to set the guest comment name.

## Importing an existing RFC collection

The repeatable Earendil RFC importer expects this layout:

```text
SOURCE/
├── people.json
└── rfcs/
    ├── 0001.md
    ├── 0002.md
    └── .media/
        ├── 0001/
        └── 0002/
```

Validate an import without changing the target workspace:

```sh
pnpm import-rfcs --source /path/to/source --dry-run
```

Sign in with an administrator account, create its personal API key, and run the import:

```sh
INKLING_URL=https://rfcs.example.com \
INKLING_API_KEY=secret \
pnpm import-rfcs --source /path/to/source
```

The importer preserves RFC numbers and metadata, rewrites known RFC links to canonical routes, uploads media, reuses attachments by digest, and publishes public RFCs after their updates complete. Pass `--publish` to also give workspace-only RFCs a published revision:

```sh
node scripts/import-rfcs.ts --source ~/Development/earendil-rfcs --publish
```

The importer is incremental: rerunning it updates matching RFC numbers and leaves unchanged documents alone.

The CLI also provides `inkling import-rfc` for a single legacy RFC and `inkling import-jot` for a Markdown file plus a legacy Jot metadata sidecar.

## Architecture

The implementation is split into runtime-independent domain, collaboration, protocol, rendering, backend, and import packages, with separate browser, Node.js, and Cloudflare adapters. Authoritative edits are journaled before acknowledgement, while rendered HTML, Markdown exports, search indexes, and catalogs remain rebuildable projections.

See [`INKLING_ARCHITECTURE.md`](INKLING_ARCHITECTURE.md) for the complete design and invariants.

## Checks

Run the full formatting, lint, typecheck, test, and build suite with:

```sh
make check
```

Apply automatic formatting with:

```sh
make format
```
