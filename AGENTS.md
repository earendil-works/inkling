# Jot agent guide

## Source of truth

Read `JOT_ARCHITECTURE.md` before changing behavior or package boundaries. This is a clean-room implementation: use the old systems only to inventory behavior and build migration fixtures, not as source code to adapt.

Do not create a root `README.md` until the project owner requests one.

## Workflow

- Use pnpm and keep `pnpm-lock.yaml` current.
- Put tests under the owning package's `test/` directory as `*.test.ts`.
- Use `make format` to apply automated fixes.
- **Before every commit, `make check` must pass.** The Husky pre-commit hook enforces this; do not bypass it or weaken checks to make a change pass.

## Package boundaries

- `core`: runtime-independent domain behavior and application/storage contracts.
- `collaboration`: shared Yjs behavior for clients and document authorities.
- `protocol`: versioned HTTP and WebSocket contracts.
- `renderer`: deterministic, safe Markdown rendering.
- `backend`: runtime-neutral Fetch API composition.
- `frontend`: browser application; CodeMirror owns text editing.
- `runtime-node`: Node HTTP, WebSocket, filesystem, locking, and journal adapters.
- `runtime-cloudflare`: Worker, Durable Object, alarm, and R2 adapters.

Dependencies point inward. Shared packages must remain browser-, Node-, and Worker-portable. Runtime differences belong in adapters, not conditionals spread through shared code. Avoid generic `utils` packages and deep imports into another package's internals.

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
