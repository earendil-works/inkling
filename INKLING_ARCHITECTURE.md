# Inkling Architecture

Status: Proposed clean-room architecture

## 1. Purpose

Inkling is an open-source, multiplayer Markdown workspace. It must run as a self-contained local server and as a Cloudflare deployment without changing its document model, collaboration protocol, or user-facing behavior.

The immediate product goal is to replace the existing Earendil RFC authoring and publishing system while retaining Inkling's collaborative editor, comments, sharing, and agent-friendly CLI.

This document is the implementation specification for a clean-room rewrite. It records the required behavior of the existing systems and defines the new architecture. The implementation should be derived from this document and its tests rather than by incrementally adapting the current server and browser code.

## 2. Goals

The architecture must provide:

- Correct real-time editing by multiple human and agent participants.
- One natural deployment model for local Node.js and Cloudflare.
- One Durable Object per document in the Cloudflare runtime.
- R2 as the long-term store for document checkpoints, published artifacts, exports, revisions, and attachments.
- Durable acknowledgement of edits before clients are told that an edit was accepted.
- A small workspace-level coordinator for catalog operations and RFC number allocation.
- A first-class RFC metadata and publication model.
- Public, private, confidential, and capability-shared documents.
- Inline threaded comments anchored to collaborative text positions.
- A stable HTTP API and CLI suitable for coding agents.
- Simple backup, export, import, and disaster recovery.
- No required database or external service for local installations.
- No required D1, Queue, or third-party collaboration service for Cloudflare installations.
- A codebase divided by domain responsibility rather than runtime-specific duplication.

## 3. Non-goals for the initial rewrite

The first clean-room implementation does not need to provide:

- A globally distributed multi-primary collaboration system outside Cloudflare's Durable Object coordination model.
- A general-purpose relational database or arbitrary user-defined document schema.
- Unlimited offline editing. Short reconnects and retrying unacknowledged updates are required; indefinitely disconnected editing is not.
- A complete Google Docs bidirectional synchronization system.
- Import of Google Docs comments that are not present in the Markdown export.
- A large-scale search service intended for millions of documents.
- Billing, cross-organization administration, or a hosted multi-tenant control plane.
- Operation-level history browsing in the first milestone, although the storage model must not prevent later revision history.

## 4. Design principles

### 4.1 A document is the unit of coordination

Every document has one authority for mutable state. On Cloudflare, that authority is the document's Durable Object. Locally, it is the corresponding in-process document room.

No workspace-wide coordinator is placed in the live editing path.

### 4.2 Acknowledged edits are durable

A server must not acknowledge an edit merely because it exists in memory. An edit is acknowledged only after it has been appended to durable document storage. R2 synchronization may happen later because the durable tail remains recoverable.

### 4.3 R2 stores compact, portable state

R2 contains compact document checkpoints, Markdown exports, published representations, immutable attachments, and catalog projections. Durable Object storage contains the mutable head and the uncheckpointed tail.

After a successful checkpoint, old document updates may be removed from Durable Object storage. An idle document should be recoverable from its R2 checkpoint plus any remaining durable tail.

### 4.4 Derived data is rebuildable

Markdown exports, rendered HTML, search indexes, snippets, state indexes, keyword indexes, and public catalogs are projections. Failure to update a projection may make a read temporarily stale, but must never lose a document.

### 4.5 Security-sensitive metadata is structured

Visibility, sharing, publication, and permissions are not inferred from collaborative Markdown alone. They are structured fields changed through validated commands.

Collaborative frontmatter may propose authors by email address, publication state, visibility, and labels. Those values drive the live publication preview, but they do not change authorization while editing. Known author emails resolve through the workspace people directory so rendered metadata uses the account’s display name; unknown emails render as themselves. The document title is the first top-level Markdown heading and is cached in structured state only as a derived projection. An authorized, explicit publish command validates and promotes frontmatter values into the structured metadata stored with the published revision. Sharing, RFC allocation, and publication state are never controlled by frontmatter.

### 4.6 Local and Cloudflare are adapters around the same core

The domain model, commands, authorization decisions, collaboration messages, rendering rules, and persistence contracts are runtime-independent. Node.js and Cloudflare provide transport and storage adapters.

### 4.7 Prefer mature collaboration primitives

Inkling should use a mature collaborative text implementation rather than maintain separate server and browser text-rebasing algorithms. The target design uses Yjs for the Markdown body and CodeMirror 6 for editing.

## 5. Existing functionality to retain

This section describes behavioral requirements, not implementation guidance.

### 5.1 Current Inkling functionality

#### Workspace and note management

- The landing page lists public published notes and RFCs for anonymous visitors and the complete workspace for authenticated users. Numbered RFCs stay in descending RFC order; unnumbered notes stay in descending activity order and interleave with RFCs by update time.
- Users can create, open, rename, search, and delete documents.
- Search matches titles and document content and returns useful snippets.
- Documents have stable opaque identifiers, creation timestamps, and update timestamps.
- Empty-state and mobile experiences remain usable.

#### Collaborative Markdown editing

- Multiple browser tabs and users can edit the same Markdown body concurrently.
- Remote edits converge without dropped or reordered text.
- Cursors and selections remain stable across remote updates.
- Remote participant cursors and names are visible.
- Typing, paste, line breaks, deletion, word deletion, composition input, undo, and redo behave like a normal editor.
- The editor reports disconnected and reconnecting states.
- An editable share link participates in the same collaboration session as an authenticated editor.

#### Preview and rendering

- The editor has a Markdown source view and rendered preview.
- Preview updates while editing.
- GitHub-flavored Markdown, line breaks, tables, links, images, code blocks, and syntax highlighting are supported.
- Mermaid code blocks render as interactive diagrams with pan, zoom, and reset controls.
- Unsafe rendered content is not allowed to execute scripts or inject dangerous markup.
- Light and dark themes are supported.
- Mobile users can open and dismiss a full-screen preview.

#### Comments

- A comment thread can be created from a selected text range.
- A thread has one root message and threaded replies with explicit parent relationships.
- Messages record author, creation time, update time, and body.
- Authorized users can edit and delete their own messages.
- Administrators can manage all messages and delete whole threads.
- Threads can be resolved and reopened.
- Resolved threads can be hidden or shown.
- Comment anchors are highlighted in the rendered preview and associated with a side rail or mobile dialog.
- Concurrent participants receive comment updates without reloading the page.

#### Sharing

- Every document can have a stable capability URL.
- Share access can be disabled or set to view, comment, or edit.
- Changing access does not require changing the URL.
- View access exposes only the rendered document and permitted metadata.
- Comment access permits named guests to create and participate in threads.
- Edit access permits collaborative body editing and commenting.
- A revoked or downgraded capability immediately loses the removed permission.

#### Authentication and API keys

- Workspace access uses verified Google identities from configured email domains in every runtime.
- Browser sessions survive normal restarts and can be revoked by logout.
- Every authenticated user can create labeled personal API keys, see only their own key metadata, and revoke their own keys.
- An API key retains its creator's identity and workspace role rather than becoming a workspace-wide administrator credential.
- Raw session tokens, capability tokens, and API keys are never stored in plaintext.
- Bearer API keys provide non-browser access.

#### CLI and agent use

- The CLI can register named Inkling installations with an API key.
- The CLI can register a shared document directly from its capability URL.
- Authenticated commands include list, search, read, create, update, edit, delete, share, comment, reply, resolve, reopen, and comment management according to the user's role.
- Shared commands include read and the operations allowed by the capability.
- Large documents can be read by line range.
- Agent text edits identify unique existing text and replace it; ambiguous or missing text is rejected rather than guessed.
- Read output includes comment thread and message identifiers so agents can reply precisely.
- The browser reveals a newly created API key once and provides a direct copy action.
- Every deployment serves public, origin-aware CLI and skill instructions at `/AGENTS.md` so a user can point an agent at the workspace itself.

#### Local operation

- Inkling can be installed and run from the CLI without Cloudflare or another service.
- The port and data directory are configurable.
- Docker deployment with a persistent data volume is supported.
- Human-readable Markdown files are available for grep, backup, and external tools.

### 5.2 Earendil RFC functionality to absorb

#### RFC metadata

The target document model must represent:

- Sequential RFC number.
- Title.
- Authors.
- Created and meaningfully updated dates.
- State.
- Visibility: public, private, or confidential.
- Keywords or labels.
- Reviewers.
- Approvers.
- Target decision date.
- Related documents.
- Legacy source URL where applicable.

Expected RFC states include draft, discussion, published, accepted, implemented, abandoned, and other workspace-configured labels. Unknown imported states must be preserved.

#### Publication and navigation

- RFCs have zero-padded canonical number routes.
- Legacy RFC routes redirect to canonical routes.
- The index keeps numbered RFCs in descending RFC order, interleaves unnumbered notes by update time, and exposes state, update date, visibility, and labels.
- State and keyword index pages are available.
- Search matches number, title, authors, reviewers, approvers, labels, visibility, state, and summary text.
- Public visitors see only public, published material, including the anonymous landing-page catalog.
- Authenticated workspace members can see private and confidential material.
- Confidential material is visibly distinguished from private material even though both initially use the same access policy.
- Public pages can be cached aggressively without leaking internal metadata.

#### RFC rendering

- RFC pages have stable heading anchors and a table of contents.
- Code blocks have light and dark syntax themes.
- Internal links to known RFC source documents are rewritten to canonical Inkling RFC routes during import or rendering.
- Images and imported media are served under the RFC's authorization policy.
- Image dimensions represented in imported Markdown are preserved when possible.
- External links can optionally require workspace authentication before redirecting.
- Public pages include canonical URLs, descriptions, and social preview metadata.
- Theme selection supports light, dark, and system preference.

#### Identity and people metadata

- People can be represented by canonical display name and email address.
- Imported aliases can be normalized through a workspace people directory.
- Search continues to match canonical names, primary email addresses, and known aliases.
- Google Workspace directory synchronization refreshes canonical names and aliases without changing email-identified document authorship.

#### Google authentication

- A Cloudflare deployment must eventually support Google OAuth with a configured allowed domain.
- Only verified email addresses from the allowed domain become workspace members.
- Authentication state is represented independently from document authorization.
- Public RFCs remain readable without login.

#### Migration compatibility

- Existing RFC Markdown frontmatter and top-level headings can be imported.
- RFC numbers, dates, states, visibility, source URLs, and labels are preserved.
- Existing media directories are imported into document attachment storage.
- Existing public number routes continue to work after cutover.

## 6. Target system topology

### 6.1 Request entry point

All browser, CLI, and public requests enter through one HTTP runtime:

- A Cloudflare Worker in hosted mode.
- A Node.js HTTP server in local mode.

The entry point is responsible for:

- Static application assets.
- Session and capability resolution.
- Workspace routing.
- Public page and artifact delivery.
- Routing document commands and WebSocket upgrades to the correct document authority.
- Routing catalog and workspace commands to the workspace authority.
- Applying response caching rules.

The entry point does not mutate collaborative document state itself.

### 6.2 Document authority

There is one document authority for every document identifier.

On Cloudflare this is one Durable Object per document. The Durable Object identifier is deterministically derived from the workspace and document identifiers. Requests for the same document therefore always arrive at the same authority.

Locally this is an in-process document room selected by the same logical key. A room is loaded on demand and can be released from memory after it becomes idle.

The document authority owns:

- Current collaborative body state.
- Document metadata.
- Comment threads.
- Share configuration and revocation generation.
- Monotonic document revision.
- Connected editor and viewer sockets.
- Presence broadcasting.
- Durable update journal.
- R2 or filesystem checkpoint scheduling.
- Document-level authorization enforcement.
- Document search projection generation.

### 6.3 Workspace authority

There is one lightweight workspace authority per workspace.

On Cloudflare this is a workspace Durable Object. Locally it is an in-process workspace coordinator with durable local storage.

It owns only control-plane concerns:

- Workspace configuration.
- Document registry and tombstones.
- RFC number allocation.
- Catalog summaries and search projection.
- Workspace roles and identity references.
- API key metadata and hashes.
- People directory.
- Public catalog generation.
- Workspace-level import coordination.

It does not relay document WebSockets or body edits.

### 6.4 Object storage

Object storage is provided by:

- R2 in Cloudflare mode.
- A filesystem-backed object store in local mode.

It stores:

- Compact latest document checkpoints.
- Published document checkpoints and rendered artifacts.
- Optional immutable historical revisions.
- Markdown and metadata exports.
- Attachments and imported media.
- Workspace and public catalog projections.
- Backup manifests.

The bucket is private. Public access always passes through the Inkling HTTP runtime so visibility and cache policy can be enforced.

## 7. Document model

### 7.1 Identity

A document has an opaque immutable identifier. RFC number is a separate optional presentation identifier.

Opaque identifiers are used for storage, Durable Object routing, API references, and internal links. New identifiers retain a two- or three-character readable type tag and base62 representation, but encode UUIDv7 bytes so their source carries creation time rather than being purely random. Generated tags are `doc`, `key`, `ses`, `att`, `cap`, `thr`, `msg`, `req`, `upd`, `par`, `tmp`, `gst`, `imp`, `rep`, and `gdo`. Existing opaque identifiers and credentials remain valid. Secret session, API-key, and capability tokens remain independently generated cryptographic random values. RFC numbers are used for canonical public routes and display.

RFC numbers are allocated monotonically within a workspace and are never reused, including after deletion.

### 7.2 Structured metadata

A document carries structured fields for:

- Identifier and optional RFC number.
- Derived title cached from the first top-level Markdown heading.
- Lifecycle state.
- Public, private, or confidential visibility.
- Labels.
- Authors, reviewers, and approvers.
- Creation and update timestamps.
- Optional target decision date.
- Related document references.
- Optional legacy source URL.
- Current head revision.
- Optional published revision.
- Sharing policy.

Authoritative metadata is changed by explicit document commands. The cached title is refreshed from accepted body updates, and author email identifiers are promoted from validated frontmatter during publication. The collaborative body cannot alter permissions or publication state.

### 7.3 Collaborative body

The body is a Yjs text value containing Markdown and optional publication frontmatter. It is the only directly collaborative field in the initial design. Its first top-level heading is the document title. Renderers present that heading in the document hero rather than duplicating it in prose, and catalog metadata caches its plain-text value as a rebuildable projection.

Publication frontmatter contains collaboratively edited presentation values such as author email addresses, lifecycle state, intended visibility, and labels. Renderers omit it from prose and use it for live preview. Author entries use normalized email addresses as stable identifiers and resolve display names from the workspace people directory when known. Structured metadata remains authoritative for authorization until an explicit publish command validates and promotes the frontmatter values. Metadata outside the title heading and publication frontmatter is changed through serialized server commands rather than opaque collaborative changes.

### 7.4 Comments

Comments are structured document state managed by the document authority. They are not embedded into Markdown.

A thread records:

- Immutable thread identifier.
- Anchor.
- Resolved state.
- Creation and update timestamps.
- Ordered messages.

A message records:

- Immutable message identifier.
- Optional parent message identifier.
- Stable author reference and display name snapshot.
- Plain-text or constrained Markdown body, according to workspace policy.
- Creation and update timestamps.
- Deletion state when audit retention requires tombstoning.

### 7.5 Comment anchors

The primary anchor uses Yjs relative positions for the beginning and end of the selection. This allows the range to move as text is inserted or removed around it.

Every anchor also retains:

- Quoted text at creation time.
- Bounded prefix and suffix context.
- Original character offsets.

The fallback information is used for display, import, re-anchoring after a destructive body replacement, and diagnosing orphaned comments.

An anchor that cannot be resolved is marked orphaned rather than silently attached to unrelated text.

### 7.6 Attachments

Attachments are immutable R2 or filesystem objects associated with a document. Attachment metadata includes original filename, media type, size, content digest, creation time, uploader, and optional image dimensions.

Markdown refers to stable Inkling attachment URLs rather than directly exposing bucket keys.

Replacing an attachment creates a new attachment identifier. Garbage collection happens only after confirming that an attachment is unreferenced and outside the configured retention period.

## 8. Collaboration architecture

### 8.1 Technology choice

The target editor uses:

- Yjs for collaborative text state and synchronization.
- CodeMirror 6 for Markdown editing.
- Yjs awareness semantics for ephemeral presence.
- Yjs relative positions for comment anchors.

There must be one shared collaboration package used by browser and server. The clean-room implementation must not maintain a separate handwritten browser approximation of the server's text structure.

### 8.2 Connection lifecycle

A client connecting to a document:

1. Resolves its identity or capability at the request entry point.
2. Reaches the document authority with authenticated context.
3. Is re-authorized by the document authority.
4. Exchanges Yjs state vectors and missing updates.
5. Receives current metadata, comment revision, permissions, and participant presence.
6. Begins sending local body updates and presence changes.

A reconnect repeats state-vector synchronization. Duplicate Yjs updates are harmless and unacknowledged client updates may be retried.

### 8.3 Durable edit processing

For each accepted body update, the document authority:

1. Validates permission, message size, and document size limits.
2. Assigns a monotonically increasing server sequence.
3. Appends the update and sequence to durable document storage.
4. Applies the update to the in-memory Yjs document.
5. Updates the document revision and dirty checkpoint state.
6. Acknowledges the sender.
7. Broadcasts the accepted update to other participants.
8. Schedules checkpoint work.

Persistence occurs before acknowledgement and broadcast. A process failure may cause a client to retry, but it must not cause an acknowledged update to disappear.

### 8.4 Presence

Presence includes participant identifier, display name, color, cursor or selection, and last activity time. Editor sessions render remote selections and labeled cursors, with stable per-identity colors generated in OKLCH and translucent selection treatment mixed in Oklab.

Presence is ephemeral:

- It is broadcast but not written to R2.
- It may be lost when all clients disconnect or a room restarts.
- Stale presence expires automatically.
- A reconnect republishes current presence.

Cloudflare mode uses hibernating Durable Object WebSockets so idle open documents do not require continuously billed execution.

### 8.5 Undo and redo

Undo and redo are scoped to the local participant's changes. A participant's undo must not remove another participant's edits. Editor history is reset only when required by a destructive administrative operation or an incompatible migration.

### 8.6 Disconnected editing

The initial product guarantees transient reconnect behavior, not indefinite offline-first authoring.

The client retains unacknowledged updates while the page remains open and retries after reconnect. The UI clearly indicates when the connection is unavailable. Whether typing remains enabled during a disconnect is a product choice, but unsynchronized edits must never be reported as saved.

## 9. Durable Object and checkpoint lifecycle

### 9.1 Durable document state

Document Durable Object storage contains:

- R2 checkpoint revision and digest.
- Current server sequence.
- Uncheckpointed update log.
- Uncheckpointed metadata and comment events.
- Dirty checkpoint marker.
- Pending catalog notification state.
- Pending deletion or publication work.

It may also cache a compact current snapshot when that reduces recovery cost. Such a cache is an optimization; the required recovery inputs remain explicit.

### 9.2 Checkpoint scheduling

A document becomes dirty after an accepted body, metadata, comment, sharing, or publication-related change.

Checkpoint scheduling combines:

- A short quiet-period delay to avoid writing R2 on every keystroke.
- A maximum dirty duration so continuous editing is checkpointed periodically.
- Retry delays with bounded backoff after failures.

A Cloudflare document uses its own alarm. This is a natural fit because every document has independent dirty state and only one alarm is required per Durable Object.

The local runtime uses an equivalent per-document timer and durable journal.

### 9.3 Checkpoint transaction

A checkpoint captures an exact server sequence and document revision before beginning object-store I/O. It writes one atomic document checkpoint object containing all authoritative compact state required to reconstruct that revision.

After the checkpoint succeeds, the document authority removes only journal entries at or below the captured sequence. Updates accepted while the object-store write was in progress remain dirty and cause another checkpoint.

Derived Markdown, rendered output, and catalog summaries may be written after the authoritative checkpoint. Their failure does not invalidate the checkpoint.

### 9.4 Alarm guarantees

Alarm handlers are idempotent. They tolerate duplicate execution and delayed delivery. A failed or partial projection write is retried from durable pending state.

No correctness guarantee depends on an alarm running at an exact time.

### 9.5 Recovery

When a document authority starts without usable in-memory state, it:

1. Loads the latest successful checkpoint from object storage.
2. Verifies its schema, revision, and digest.
3. Replays durable updates and events after the checkpoint sequence.
4. Reconstructs the Yjs document, metadata, comments, and pending work.
5. Resumes checkpoint or catalog retries if necessary.

A missing checkpoint is valid only for a newly initialized document. Corrupt or incompatible state must fail closed and surface an administrative recovery error rather than initialize an empty document over existing state.

## 10. R2 and local object layout

The logical layout is identical in R2 and the local filesystem adapter.

| Object category          | Purpose                                                             |
| ------------------------ | ------------------------------------------------------------------- |
| Workspace configuration  | Non-secret workspace settings and schema version                    |
| Workspace catalog        | Rebuildable internal catalog projection                             |
| Public catalog           | Projection containing only publicly visible published documents     |
| Document head checkpoint | Latest compact recoverable document state                           |
| Published checkpoint     | Immutable or content-addressed revision selected for public serving |
| Markdown export          | Human-readable body and compatible metadata frontmatter             |
| Rendered page            | Cacheable HTML representation of a published revision               |
| Search projection        | Rebuildable normalized search data                                  |
| Attachments              | Immutable binary document assets                                    |
| Revision objects         | Optional retained historical checkpoints                            |
| Backup manifest          | Inventory and revision information for export and verification      |

Authoritative checkpoints are single objects so their internal fields cannot be observed at mismatched revisions. R2 provides no application-level transaction across multiple objects; the architecture therefore never requires a checkpoint and its projections to change atomically.

## 11. Catalog and RFC number allocation

### 11.1 Registry

The workspace authority maintains one registry entry per document, including deleted tombstones. Registry entries contain enough information to route and list documents but never contain secrets or capability tokens.

### 11.2 Creation

Document creation is an idempotent multi-step operation:

1. The workspace authority reserves a document identifier and, when requested, the next RFC number.
2. It records a pending registry entry durably.
3. The document authority initializes the document idempotently.
4. The workspace authority marks the registry entry active.

A retry may repeat any step without allocating a second RFC number or creating a divergent document.

### 11.3 Metadata projection

After relevant document changes, the document authority sends a revisioned summary to the workspace authority. The summary includes listing metadata, the title derived from the first top-level heading, an excerpt, and normalized search material.

The workspace authority ignores stale summary revisions. If delivery fails, the document authority retains a durable outbox entry and retries.

### 11.4 Search

The workspace catalog provides the current Inkling search behavior and RFC-specific search fields. The initial implementation can scan a derived normalized catalog because expected workspaces are modest in size.

The search projection includes body text for full-content search, but public catalog output contains only data from public published revisions. Search is an interface behind the workspace authority so a future larger-scale index can replace the scan without changing document storage or APIs.

D1 is not required for the initial architecture.

### 11.5 Catalog repair

An administrative repair operation rebuilds the workspace catalog from document checkpoints. Rebuilding may be expensive but must not require original Google Docs, Git history, or a live document room.

## 12. Working and published revisions

### 12.1 Working head

The working head is the latest accepted document state. Editors and explicit working-head API operations may see it according to document policy. Standard document reader surfaces never render the working head: they show the latest published revision, or an unpublished state when no published revision exists.

### 12.2 Published revision

A document may designate a checkpoint as its published revision. Public canonical routes serve this immutable revision rather than an in-progress editing head.

Before capturing the revision, publishing requires a non-empty top-level title heading, parses and validates collaborative publication frontmatter, and applies its allowed values through the same structured metadata validation used by explicit metadata commands.

Publishing records:

- Published document revision.
- Publisher identity.
- Publication timestamp.
- Rendered artifact digest.

A new publication replaces the public pointer but does not mutate the prior published checkpoint.

### 12.3 Initial publication policy

The initial clean-room implementation uses explicit publication for public canonical RFC pages. This avoids exposing half-written collaborative edits and makes public caching deterministic.

Capability read links expose the latest published revision. Capability edit sessions synchronize the current working head when their permissions allow editing.

A later workspace option may automatically publish checkpoints after a quiet period, but automatic publication is not required for the initial cutover.

### 12.4 Unpublishing and visibility changes

Changing a document away from public visibility removes it from the public catalog immediately and causes public routes to stop serving it. Cached public responses must have bounded validity or explicit invalidation so this change takes effect within a documented maximum interval.

Previously published objects may remain in private object storage for history, but are no longer reachable through public routes.

## 13. Authorization model

### 13.1 Principals

Every request resolves to one principal:

- Anonymous visitor.
- Workspace member session.
- Workspace administrator session.
- API key principal.
- Document capability principal.

An API key principal is bound to the person who created it and carries that person's workspace role. Key creation, listing, and revocation are scoped to that person; administrators do not receive a global list of other users' keys.

A guest commenter identity supplements a capability principal; it is not by itself a permission grant.

### 13.2 Actions

Authorization is expressed in terms of actions rather than route families. Relevant actions include:

- Discover document.
- Read working head.
- Read published revision.
- Comment.
- Edit body.
- Edit metadata.
- Manage comments.
- Manage sharing.
- Publish or unpublish.
- Delete or restore.
- Administer workspace.

The same authorization service is used by HTTP commands, WebSocket upgrades, reconnects, the CLI, and rendered page routes.

### 13.3 Visibility

Public visibility permits anonymous access only to a published revision.

Private and confidential visibility require a workspace principal unless a document capability grants access. Both initially use the same authorization policy, while confidential visibility communicates a higher degree of privacy and remains visually distinct. The model permits stricter confidential ACLs later.

### 13.4 Capabilities

A document capability grants view, comment, or edit permission. It has:

- Stable public URL identifier.
- Document binding.
- Permission level.
- Revocation generation or active state.
- Creation and optional expiry metadata.

Capability secrets are random, unguessable, and stored only as hashes where lookup permits. The URL contains enough routing information to select the document authority without a bucket-wide secret lookup.

The document authority validates current capability state on connection and on privileged commands. Downgrading or revoking access closes or restricts existing live connections.

### 13.5 Domain-based authentication

All runtimes use Google OAuth with configured allowed email domains. There is no bootstrap account, shared credential, or privileged local user identity. Google OAuth is an identity adapter at the request entry point; it produces verified member or administrator principals and does not change document state or collaboration protocols.

Allowed-domain checks use verified email addresses. OAuth state and sessions are signed, time-limited, secure, HTTP-only, and same-site cookies. Cloudflare requests the read-only Admin Directory user scope and, when the signed-in account is permitted to use it, refreshes the workspace people directory during login. The access token is used transiently and is never persisted; directory failure does not prevent authentication.

## 14. HTTP API and WebSocket protocol

### 14.1 API organization

The new API is resource-oriented and uses one set of document operations for members, administrators, API keys, and capabilities. It must not duplicate every operation under separate authenticated and share route implementations.

The principal and authorization policy determine the result.

API areas include:

- Authentication and session state.
- Workspace configuration and API keys.
- Document catalog and search.
- Document creation, reads, metadata updates, publication, and deletion.
- Agent-oriented body edits and line-range reads.
- Comment threads and messages.
- Sharing and capability management.
- Attachments.
- Import, export, and repair administration.

Exact path compatibility with the old implementation is optional unless needed for migration, but CLI-visible semantics must remain stable.

### 14.2 Concurrency control for commands

Non-collaborative commands operate against a document revision. Commands that could overwrite concurrent work either carry an expected revision or have semantics that are safe to apply against the current head.

Agent replacement edits search the current head at the document authority. Missing or ambiguous text is rejected. Successful multi-edit requests are atomic from the API caller's perspective.

A full body replacement is an administrative operation. It creates a new collaborative state, attempts to re-anchor comments, increments the revision, and notifies all connected clients to resynchronize.

### 14.3 WebSocket responsibilities

One document WebSocket carries:

- Yjs synchronization and accepted updates.
- Acknowledgements.
- Presence.
- Metadata and permission changes.
- Comment revision notifications.
- Access revocation.
- Resynchronization requests and structured errors.

Large attachment transfer does not use the collaboration WebSocket.

### 14.4 Protocol evolution

Every WebSocket connection negotiates a protocol version. Unknown incompatible versions are rejected with a clear upgrade requirement. Additive message changes remain backward-compatible where practical.

## 15. Rendering and publication

### 15.1 Shared renderer

Inkling has one deterministic Markdown rendering package usable from browser, Node.js, and Cloudflare where feasible. Editor preview and published output must agree on Markdown semantics.

The renderer supports:

- GitHub-flavored Markdown.
- Tables and task lists.
- Stable heading identifiers.
- Table of contents extraction.
- Code fences and language metadata.
- Syntax highlighting with light and dark presentation.
- Mermaid placeholders rendered safely in the browser.
- Images and Inkling attachment URLs.
- Link rewriting for known RFC references.
- Optional authentication-gated external links.

Raw HTML is disabled by default. If later enabled for trusted workspaces, it must pass through an explicit sanitizer with a narrow allowlist.

### 15.2 Editor preview

Preview rendering is debounced and must not block typing or collaboration. It parses publication frontmatter, omits it from rendered prose, and reflects valid draft metadata immediately without changing authorization. Author email identifiers display the corresponding workspace account name when the people directory knows it and otherwise display the email address. Mermaid diagram rendering is separately debounced and preserves pan and zoom state for unchanged diagrams where practical.

Comments are overlaid using resolved anchor positions after rendering. Rendered HTML never becomes authoritative document state.

### 15.3 Published artifacts

Publishing produces a cacheable rendered artifact and public catalog entry tied to a specific document revision. Public assets use content digests or revision identifiers so immutable resources can receive long cache lifetimes.

Authentication-varying controls are either omitted from cacheable HTML or loaded from an uncached session endpoint after page load.

### 15.4 Internal reads

Internal document reader routes serve the latest published revision and are private unless the publication is publicly visible. Explicit editor and agent working-head reads may be rendered dynamically or served from a recent private projection. They must be marked private and must not enter shared public caches.

### 15.5 Canonical routes

Numbered RFCs retain zero-padded canonical routes. Generic documents also have stable opaque routes. State and keyword routes are generated from catalog projections. Legacy RFC route shapes redirect without exposing unpublished documents.

## 16. User interface architecture

The browser application is authored in TypeScript and built as modules. It does not rely on a manually synchronized collection of global scripts.

Primary surfaces are:

- Public published-document index and search without an authentication gate.
- Workspace document index and search.
- Collaborative editor with metadata controls.
- Rendered reader.
- Public published RFC reader.
- Capability-shared reader, commenter, and editor.
- Comment rail and mobile comment dialog.
- Sharing controls.
- An account-name dropdown with personal API key management and sign out.
- Import, export, and administrative repair status.
- A personal-key dialog that reveals each newly created API key once.
- Public agent instructions at `/AGENTS.md` covering the CLI and reusable Agent Skills.

CodeMirror owns text editing, selection, composition, the title heading, and local undo. Application state owns structured metadata, comments, permissions, connection status, and preview state.

Accessibility requirements include keyboard navigation, visible focus, semantic controls, dialog focus management, reduced-motion support, and non-color-only presence indicators. The browser page title is the current note or RFC title on document routes and `Inkling` on workspace-level routes.

## 17. CLI architecture

The CLI is an API client and local server launcher; it does not access server storage directly.

It retains named instance registration for personal API keys and shared capability URLs. Credentials are stored in a user-only configuration file. A newly created API key is revealed once in the browser and is never printed by later CLI operations.

The CLI supports:

- Server startup in local mode.
- Instance registration and removal.
- List and search.
- Document read, including line ranges and comments.
- Create, rename, metadata update, publish, unpublish, and delete.
- Safe unique-text edits.
- Comment, reply, resolve, reopen, edit message, and delete operations.
- Share inspection and access changes.
- Attachment upload and download.
- Workspace import and export.
- Catalog verification and repair for administrators.

CLI output has a stable human-readable default and may later add structured JSON output without changing server semantics.

## 18. Local runtime

### 18.1 Requirements

Local Inkling runs with one command and no external database. Its configured data directory contains all durable state except optional externally configured object storage.

The runtime provides:

- Node.js HTTP serving.
- WebSocket upgrades.
- In-process workspace and document coordinators.
- Filesystem object storage.
- Durable append-only per-document journals.
- Atomic checkpoint writes using temporary files and rename.
- Static web assets.
- The same domain-restricted Google authentication used by hosted deployments.

### 18.2 Single-writer rule

Only one local Inkling process may own a data directory at a time. The server acquires a process lock and refuses to start when another healthy process owns the directory.

This keeps local coordination equivalent to one Durable Object authority per document.

### 18.3 Crash recovery

On startup, local Inkling discovers dirty journals, loads their checkpoints, replays durable updates, and schedules fresh checkpoints. Truncated final journal records are detected and ignored only when their integrity marker proves they were never fully committed.

### 18.4 Docker

The container uses the same local runtime. The complete data directory, not a nested partial notes directory, is mounted as persistent storage. Health checks cover HTTP readiness and writable storage.

## 19. Cloudflare runtime

### 19.1 Worker

The Worker handles public HTTP routing, static assets, authentication, cache policy, and Durable Object dispatch. It does not maintain mutable document state in isolate globals.

### 19.2 Document Durable Objects

Each document Durable Object:

- Accepts document API commands and WebSocket upgrades.
- Uses hibernating WebSockets.
- Stores the durable update tail and pending work.
- Loads and writes R2 checkpoints.
- Runs its own checkpoint alarm.
- Enforces document permissions.
- Notifies the workspace Durable Object through a durable outbox.

### 19.3 Workspace Durable Object

The workspace Durable Object allocates RFC numbers, maintains the document registry and search projection, and writes catalog projections to R2. Its traffic is low and unrelated to keystroke volume.

### 19.4 R2

The R2 bucket remains private and is accessed through bindings. Attachments and artifacts carry media type, digest, and cache metadata. Object writes use revision-aware names or checkpoint metadata so retries are idempotent.

### 19.5 Services not initially required

The target Cloudflare deployment does not initially require:

- D1.
- Queues.
- KV.
- Workflows.
- Scheduled Workers.
- A public R2 bucket.

These may be introduced only when a measured requirement cannot be met by document Durable Objects, the workspace Durable Object, alarms, and R2.

## 20. Failure handling and consistency

### 20.1 R2 unavailable

Editing continues while Durable Object storage has capacity. Acknowledged updates remain durable in the document tail. The document reports delayed checkpoint status, retries with backoff, and refuses further edits before storage limits could make durability unsafe.

### 20.2 Document Durable Object restart

The object reloads its R2 checkpoint and durable tail. Clients reconnect or resume hibernated sockets and synchronize by Yjs state vector. Duplicate client updates do not duplicate text.

### 20.3 Catalog notification failure

The document remains readable by identifier and no data is lost. The document outbox retries the newest revision. Search and listings may temporarily show stale metadata.

### 20.4 Catalog projection failure

Authenticated catalog reads can continue from workspace durable state. Public indexes may remain stale until projection retry succeeds. Public document authorization never relies solely on stale catalog data.

### 20.5 Partial publication

A published checkpoint is made durable before its public pointer or catalog entry changes. Readers therefore observe either the previous complete publication or the new complete publication, never a partially written document.

### 20.6 Conflicting metadata commands

Metadata commands use expected revisions or field-level conflict rules. A stale destructive update is rejected with current state rather than silently overwriting newer work.

### 20.7 Deletion

Deletion first writes a tombstone and revokes capabilities. It removes the document from catalogs and closes live connections. Physical R2 and Durable Object data deletion is delayed by a retention period and performed idempotently. RFC numbers are not reclaimed.

## 21. Security

### 21.1 Defense in depth

The request entry point resolves authentication, but document and workspace authorities enforce authorization again. Internal dispatch carries authenticated context in a form clients cannot forge.

### 21.2 Browser request protection

Cookie-authenticated mutations require same-origin requests and CSRF protection. WebSocket upgrades validate Origin and current session or capability state.

### 21.3 Content safety

- Raw HTML is disabled by default.
- Dangerous URL schemes are rejected.
- External links receive safe opener behavior.
- Mermaid input is treated as untrusted and runs under an appropriate content security policy.
- Attachment responses set explicit media type and content-disposition behavior.
- User-provided filenames never become unchecked storage paths.

### 21.4 Secret handling

- API keys, session tokens, and capabilities are random and stored as hashes where possible.
- OAuth client secrets and signing keys use runtime secret configuration, not R2 or checked-in files. Google OAuth access tokens used for directory refresh are never persisted.
- Logs never contain document bodies, raw credentials, capability URLs, or OAuth tokens.

### 21.5 Resource limits

The server enforces limits for:

- Document body size.
- Collaboration update size and rate.
- Comment and message length.
- Thread and participant counts.
- Attachment size and media types.
- Render complexity and Mermaid diagram size.
- Catalog query rate.

Limits fail with explicit errors and do not partially apply commands.

### 21.6 Cache isolation

Public published artifacts may be shared-cacheable. Private, confidential, capability, session, and working-head responses are private or uncached. Public catalogs contain no internal titles, excerpts, labels, attachment names, or existence hints.

## 22. Observability and operations

Structured logs include workspace identifier, document identifier, request or connection identifier, operation category, revision, duration, and result. They exclude content and secrets.

Operational metrics should cover:

- Active document rooms and WebSockets.
- Accepted updates and rejected updates.
- Durable append latency.
- Dirty checkpoint age.
- R2 checkpoint latency and failures.
- Durable journal size.
- Catalog outbox age.
- Publish latency and failures.
- Reconnect and resynchronization counts.
- Comment and attachment operations.

Health information distinguishes HTTP readiness, local storage writability, and recent checkpoint failures. Cloudflare mode exposes diagnostic information only to administrators.

## 23. Testing strategy

### 23.1 Domain tests

Test metadata validation, authorization, visibility, publication transitions, comments, capability revocation, RFC numbering, catalog projection, and import normalization without either runtime.

### 23.2 Collaboration tests

Use deterministic multi-client simulations to verify:

- Concurrent inserts and deletes converge.
- Same-location editing converges.
- Duplicate and reordered network delivery is harmless where the protocol permits it.
- Reconnect and state-vector synchronization recover missing updates.
- Local undo does not remove remote edits.
- Relative comment anchors survive surrounding edits.
- Full replacement produces explicit re-anchored or orphaned comments.

### 23.3 Persistence tests

Every journal and object-store adapter passes the same contract tests. Fault injection covers crashes before append, after append, during checkpoint upload, after checkpoint upload but before journal truncation, and during catalog notification.

The key invariant is that every acknowledged edit exists after recovery.

### 23.4 Runtime integration tests

Run equivalent API behavior tests against:

- The local Node.js runtime.
- A Cloudflare development runtime with Durable Objects and R2 persistence.

### 23.5 Browser tests

Automated multi-page browser tests cover normal typing, rapid typing, paste, composition, undo, reconnect, remote cursors, comments, mobile preview, share downgrades, and publication visibility.

### 23.6 Migration tests

Golden import tests cover representative legacy Jot notes and Earendil RFCs, including metadata variants, media, explicit heading identifiers, internal links, unusual states, and missing optional fields.

## 24. Migration and cutover

### 24.1 Legacy Jot import

The importer reads existing Markdown and metadata sidecars and creates new document checkpoints. It preserves where practical:

- Document identifier.
- Title and timestamps.
- Markdown body.
- Share identifier and access level.
- Comment threads, messages, authors, and resolution state.

Existing character-level collaborative state need not be preserved. The imported Markdown initializes fresh Yjs state, and comment anchors are re-established from quote and context.

### 24.2 Earendil RFC import

The importer reads the RFC Markdown collection and people directory. It preserves:

- RFC number and canonical route.
- Title and body.
- Authors, reviewers, approvers, and aliases.
- Created and updated dates.
- State, visibility, and labels.
- Target decision date and related references.
- Legacy source URL.
- Imported media and image references.

Existing public RFCs receive an initial published revision. Internal RFCs receive a working checkpoint and remain private.

### 24.3 Validation

Before cutover, a migration report compares:

- Document counts and RFC numbers.
- Metadata fields.
- Body digests after normalized import.
- Attachment counts and digests.
- Public versus internal catalogs.
- Canonical route availability.
- Rendered heading and link inventories.

Any skipped or lossy field is reported explicitly.

### 24.4 Cutover

The recommended cutover sequence is:

1. Deploy Inkling at a staging hostname.
2. Import a frozen RFC snapshot.
3. Run automated and human comparison.
4. Perform a final incremental import or short authoring freeze.
5. Publish imported public revisions.
6. Move the canonical hostname.
7. Keep the old publisher read-only for a defined rollback window.
8. Retire Google Docs synchronization only after successful verification.

## 25. Clean-room implementation boundaries

The rewrite should begin from new modules and tests organized around this architecture.

The existing implementation is used only to:

- Inventory externally visible behavior.
- Produce migration fixtures.
- Verify CLI and route compatibility where intentionally retained.
- Supply visual references and data for comparison.

The clean-room implementation should not:

- Add Cloudflare conditionals throughout the existing monolithic server.
- Preserve separate authenticated and shared copies of every route.
- Preserve the current server/browser collaborative algorithms.
- Treat filesystem calls as the domain persistence API.
- Treat Markdown exports as authoritative collaborative state.
- Put all document WebSockets through the workspace Durable Object.
- Require successful R2 writes for every keystroke.
- Use an in-memory process map as the only acknowledged state.

Suggested source boundaries are domain, collaboration, application services, storage contracts, rendering, web client, CLI, Node runtime, and Cloudflare runtime. Directory names may differ, but dependencies must point inward toward runtime-independent behavior.

## 26. Implementation phases

### Phase 1: Domain and persistence foundation

- Define document, metadata, comments, identity, authorization, and publication behavior.
- Define object-store and durable-journal contracts.
- Implement local storage adapters and recovery tests.
- Implement RFC and legacy Jot importers.

### Phase 2: Local collaborative vertical slice

- Build the CodeMirror and Yjs editor.
- Build the local document room and WebSocket protocol.
- Implement durable append, checkpoint, and crash recovery.
- Prove multi-tab convergence with automated browser tests.

### Phase 3: Cloudflare document runtime

- Implement the Worker dispatcher.
- Implement one document Durable Object per document.
- Add hibernating WebSockets, alarms, R2 checkpoints, and fault tests.
- Confirm behavioral parity with local mode.

### Phase 4: Workspace catalog and RFC model

- Implement workspace authority and RFC number allocation.
- Implement metadata, indexes, search, people normalization, and canonical routes.
- Add public and internal catalog projections.

### Phase 5: Comments, capabilities, and agents

- Implement relative-position comments and comment UI.
- Implement share capabilities and live revocation.
- Implement API keys, CLI commands, and agent instructions.

### Phase 6: Publication and migration

- Implement explicit published revisions and cacheable artifacts.
- Complete RFC rendering, attachments, state and keyword pages, and social metadata.
- Run staged Earendil migration and route comparison.

### Phase 7: Google authentication

- Add Google OAuth and allowed-domain workspace membership.
- Migrate production internal access from bootstrap authentication.
- Use the same allowed-domain authentication policy for self-hosted installations.

## 27. Initial acceptance criteria

The clean-room rewrite is ready for production migration when:

1. Two or more editors converge under normal and adversarial editing tests.
2. Every acknowledged edit survives injected process and checkpoint failures.
3. An idle Cloudflare document uses a hibernating WebSocket or no active compute.
4. Each document has its own Durable Object and checkpoint alarm.
5. R2 contains restorable checkpoints, Markdown exports, published artifacts, and attachments.
6. Local mode requires no Cloudflare service and passes the same behavior tests.
7. Comment anchors remain attached through ordinary concurrent editing.
8. Share access changes affect existing connections promptly.
9. Public routes cannot reveal internal catalog or document data.
10. Legacy Jot CLI workflows have equivalent supported operations.
11. All existing Earendil RFCs import with preserved numbers, metadata, bodies, and media or appear in an explicit loss report.
12. Public RFC canonical routes, state pages, keyword pages, search, themes, code rendering, and social metadata are operational.
13. The catalog can be rebuilt from object-store checkpoints.
14. Backup export and restore have been tested on a fresh installation.
15. The old Google Docs sync system is no longer required for authoring or publication.

## 28. Decisions recorded by this document

- Cloudflare uses one Durable Object per document.
- A separate workspace Durable Object handles only catalog and allocation concerns.
- Document edits are persisted durably before acknowledgement.
- R2 synchronization is alarm-driven and combines quiet-period debounce with a maximum dirty interval.
- R2 checkpoints and the remaining Durable Object tail form recoverable document state.
- The local runtime mirrors these roles with in-process rooms, durable journals, and filesystem object storage.
- Yjs and CodeMirror replace the custom collaborative text implementation.
- Structured metadata is separate from collaborative Markdown.
- Comment anchors use collaborative relative positions with textual fallbacks.
- Public canonical pages serve explicit published revisions.
- Reader and capability-view links serve the latest published revision; editor sessions use the authorized working head.
- The first top-level Markdown heading is the document title.
- Catalogs and rendered outputs are rebuildable projections.
- D1 and Queues are not required initially.
- Google OAuth is an identity adapter and can be added after the core architecture is operational.
