# Inkling agent guide

## Workflow

- Use pnpm and keep `pnpm-lock.yaml` current.
- Put tests under the owning package's `test/` directory as `*.test.ts`.
- Use `make format` to apply automated fixes.
- **Before every commit, `make check` must pass.** The Husky pre-commit hook enforces this; do not bypass it or weaken checks to make a change pass.

## Effect

All domain, application, and runtime logic is built on the JavaScript `effect` ecosystem. Model expected failures as typed errors, dependencies as `Context` services supplied by `Layer`, resource lifetimes with `Scope`, and concurrent work with Effect primitives. Use `Schema` for validation and wire decoding. Raw promises, thrown expected errors, and ambient singletons belong only in thin platform boundaries and must be lifted into Effect immediately.

## Package boundaries

- `core`: runtime-independent domain behavior and application/storage contracts.
- `collaboration`: shared Yjs behavior for clients and document authorities.
- `protocol`: versioned HTTP and WebSocket contracts.
- `renderer`: deterministic, safe Markdown rendering.
- `backend`: runtime-neutral Fetch API composition.
- `frontend`: browser application; CodeMirror owns text editing; Elanor owns UI components.
- `runtime-node`: Node HTTP, WebSocket, filesystem, locking, and journal adapters.
- `runtime-cloudflare`: Worker, Durable Object, alarm, and R2 adapters.
- `deployments/*`: concrete deployments shaped like `templates/cloudflare`; configuration only, no application code.

Dependencies point inward. Shared packages must remain browser-, Node-, and Worker-portable. Runtime differences belong in adapters, not conditionals spread through shared code. Avoid generic `utils` packages and deep imports into another package's internals.

## Frontend UI

- Build UI from Elanor (`@earendil-works/elanor-react`), the design system installed from npm at the version pinned in `packages/frontend/package.json`. Use its components and documented props (the `.mdx` docs in the Elanor repository's `packages/react/src/` at that version's `v<version>` tag). Don't style Elanor's internals or rely on undocumented `data-*` attributes; when Elanor lacks something, change Elanor rather than working around it.
- Dependabot opens one PR for each Elanor release; see `packages/frontend/ELANOR.md`.
- Style with Elanor's semantic tokens (`--semantic-*`) and Inkling's domain tokens in `packages/frontend/src/styles/tokens.css`; no literal colors, sizes from the token scale. Deployment themes override both.
- Navigation that looks like a button uses `ButtonLink`, so it keeps the link role.

## Architectural rules

- One document authority owns each document; the workspace authority never handles live editing traffic.
- Persist accepted edits to the durable journal before acknowledging or broadcasting them.
- A checkpoint plus its remaining durable tail must recover every acknowledged edit.
- Checkpoints are authoritative; Markdown, HTML, search data, and catalogs are rebuildable projections.
- Security-sensitive metadata is structured state, never inferred from Markdown.
- Document authorities re-authorize operations instead of trusting the request entry point.
- Public routes serve explicit published revisions; capability routes serve only the authorized working head.
- Comments use Yjs relative positions with textual fallback and become orphaned rather than guessed.
- RFC numbers are monotonic and never reused.
- Make retries, alarms, imports, publication, projections, and deletion idempotent.
- Never log document bodies or secrets, and never place private responses in shared caches.
