# Web frontend

The React 19 application lives in `/web` as a standalone pnpm project. It uses
Vite, TypeScript, Tailwind CSS, Vitest, and Playwright.

Production requests are same-origin. The Go executable serves the embedded
bundle with SPA fallback, one-year immutable caching for hashed `/assets/`, and
`no-cache` for the HTML shell and top-level files. Vite proxies API paths to
`127.0.0.1:3001` during development.

The Go browser boundary applies the CORS allowlist and defense-in-depth browser
headers to API, SPA, and public responses: CSP, frame denial, MIME sniffing
prevention, a bounded permissions policy, and a referrer policy. New browser
methods must also be added to the explicit preflight method list.

The application has one i18n boundary under `web/src/i18n`, one workflow store,
and error boundaries around major workspaces. Accessibility, localization,
browser behavior, bundle budgets, and zero-console-error E2E are acceptance
requirements.

New contract-first surfaces use `contractApi` with operation types generated
from `contract/openapi.json`. Authoring additionally validates the parsed
success payload in `web/src/lib/authoring-contract.ts` before a proposal can
reach Apply; generated types protect compilation, while the bounded runtime
guard protects against stale proxies or malformed success JSON. Apply also
binds the duplicated intent/recovery contracts and qualification flags to the
exact workflow snapshot, dynamically loading the full strict Recovery Contract
validator only when a reviewed proposal carries recovery policy. The validated
snapshot is cloned before confirmation and catalog refresh so shared UI state
cannot change the object copied into the canvas.

Successful HTTP responses with unreadable bodies are errors, not empty success
objects; cancellation remains `AbortError`. A genuinely empty body remains
compatible with bodyless endpoints. Non-success responses retain their HTTP
status even if error details cannot be read. Before polling mutates run state,
`src/lib/run-status-contract.ts` validates the entire summary, nodes, events and
pagination projection, including run identity and duplicate row identifiers.
Malformed snapshots leave the previous projection intact; stale requests are
discarded before validation. A later valid poll can recover normally, and
refreshing the latest event page never rewinds already-loaded history.

Browser-owned runtime schemas use the tree-shakeable `zod/mini` entry point.
They must preserve the same strict-object, bound, default, transform, and
refinement semantics as the API contract; do not trade validation coverage for
bundle size. Top-level schema factories are marked pure so unused request-body
schemas do not execute merely because a module also exports a shared enum.
Semantic recovery response parsing lives in
`web/src/lib/recovery-case-contract.ts` and shares the lazy
`recovery-contract` chunk with the workflow recovery validator. The React
panel consumes only the already-bounded read model. Authoring guards are loaded
on demand by workflow commands, keeping the default app workspace below its
immutable budget without weakening the final Apply boundary.

The canvas keeps React Flow identity separate from optional persisted DAG edge
identity. `workflowToGraph` uses a unique local id even for malformed historical
duplicates, carries the original id in edge data, and `getWorkflowJson`
round-trips that original value. Never silently replace a persisted edge id
with an array index: validation and recovery evidence may refer to it.

The versioned DAG's inline `metadata` is a closed descriptive shape
(`description`, `tags`), not a generic extension bag. Operational metadata uses
the dedicated workflow-metadata API. Run-snapshot guards validate this shape,
the DSL version, recursive inputs, outputs, finite positions, and edge fields
before hydrating the canvas; malformed historical or proxy data is rejected as
a whole instead of being partially rendered.

Do not add a second frontend project, root package workspace, production API URL
setting, or separate production web process.

Workflow and recovery substring search share `web/src/lib/text-search.ts` with
the Go API boundary. The raw input remains visible, while only a valid,
Unicode-bounded term is debounced and sent. Short in-progress terms show neutral
guidance rather than issuing a database request; overlong or control-containing
terms show inline validation. This keeps browser behavior and direct API clients
consistent without counting UTF-16 code units as characters.

Runtime shape guards (`isRecord`, `asRecord`, `asRecordOrEmpty`) live in
`src/lib/guards.ts` only; `scripts/check-duplicate-guards.mjs` (part of
`pnpm lint`) rejects a second definition. The `/org/config` payload has one
reader, `src/lib/org-config-model.ts`. AI Studio and the Inspector load
lazily like every other tab panel: `src/components/panel-loaders.ts` holds one
dynamic importer per tab, `RightPanel` builds its `lazy()` components from
them, and `WorkspaceSectionNav` reuses those importers on hover/focus. The
`authoring-workspace` group also contains shared dependencies, so its code can
load before an authoring panel mounts. `lazy()` defers mounting, not necessarily
transfer; a second destination-level preload effect is unnecessary. First-open
navigation uses the Suspense fallback if its import is still pending.
Stylesheets follow the
chunk that renders them: a rule whose classes are owned only by lazy-loaded
components lives next to its owner (`<Component>.css`, or `<folder>/<folder>.css`
for a split panel such as `recovery-dialog/`) and is imported by that component,
so Vite emits it with the lazy chunk; `src/styles/*.css` keeps only what the
shell and eager panels use. That cut the eager `index.css` from 41 to 25 KiB
gzip (2026-09). When adding styles for a lazy panel, put them in its adjacent
sheet; `scripts/check-css-classes.mjs` still requires every class to have a
production owner wherever the sheet lives. `RightPanel` and `AppWorkspace` are memoized, and the shell's derived counts
are memoized on their inputs, because the shell renders on every store tick.
Dialogs get Escape from `useDialogFocusTrap`'s `onEscape` option rather than
their own keydown effects.
Every product action is the `Button` primitive (`components/ui/Button.tsx`):
`size="sm"` for inline row and toolbar actions, `variant="primary"` for the
one action a surface leads with, `variant="danger"` for destructive ones,
`size="icon" variant="ghost"` for icon-only controls, and `aria-pressed` for
toggles (the primitive styles the pressed state). The legacy `small-command`
and `icon-button` classes are gone from buttons; raw `<button>` remains only
for non-action semantics — tabs, radios, menu items, list rows, chips — that
carry their own component styles.

## Routing

The workspace URL is a hash route owned by `src/lib/route.ts`: `#/<tab>` for
a tab, `#/recoveryCase/<id>` for one case, `#/runs/dlq[/<deadLetterId>]` for
the recovery queue (heading or one failure), `#/runs/day/<YYYY-MM-DD>` for a
day filter and `#/operations/<section>` for an Operations sub-section. Hash
routing keeps the served bundle one static document, so no server rewrite and
no API path can shadow it. The store writes the route when a tab or case
opens (`setActiveTab`, `openRecoveryCase`) and never clobbers a richer route
for the same tab; `useRouteSync` writes the restored tab on a cold load with
no hash and adopts browser navigation (back, forward, a typed hash) through
`applyRoute` without writing it back. The navigation buses — recovery-queue
focus, day focus and the Operations section — spell their requests as routes
and read them back on mount (consume-once), keeping a live `CustomEvent` only
for consumers already mounted; the DOM-focus buses (authoring problems,
resilience) stay events because they are not navigation. `?deadLetterId=`
from alert notifications remains a supported alias of the dlq route.

## Data invalidation

Panel reads subscribe to the resources they depend on through
`src/lib/query-cache.ts` (`useInvalidationNonce(tags)`, tags typed as
`ResourceTag`), and mutations name what they changed: the store action
`bumpPlatformVersion(tags)` invalidates only those tags, while the bare
`bumpPlatformVersion()` still broadcasts through the `platform` bridge tag.
Every panel subscribes to `[PLATFORM_TAG, ...its tags]`, so a same-domain
mutation (a member role change, an MCP connection, a budget save) refreshes
only the panels that read that resource, and a cross-domain command (a run
start, a workflow save, a recovery replay) still refreshes everything. Bumps
within 100 ms coalesce into one invalidation wave without updating the workflow
store. There is no parallel global refresh counter. When adding a panel,
declare its tags next to the component; when adding a mutation, pass the tags
it changes, or leave the call untagged when the blast radius is unclear.

## Version history ownership

History pages and suggestions belong to the current organization, operator,
saved workflow and effective permissions. Refresh or navigation aborts owned
work; a new comparison cannot reactivate an older suggestion request. Loading,
read failure and empty history are distinct, and retry creates a fresh request.

Loading a history row retains its immutable version ID and number in the canvas,
so an unedited run can bind the exact source version. Confirming discarded edits
must still match the initiating context and semantic canvas revision; a stale
confirmation does not overwrite a workflow selected or edited in the meantime.

Rollback confirmation owns a cloned current/target preview and the initiating
operator, permissions and canvas revision. Cancel receives initial focus, and
unsaved edits are disclosed before confirmation. Context changes abort local
ownership, not an already accepted server write. A success receipt must match
the workflow and source version and identify a newly created version before
hydration or success feedback; the canvas retains that new immutable identity.
Success closes the dialog and announces the new version in a toast. Workflow
commands and rollback share the same canvas ownership token and immutable
identity parser, rather than maintaining independent copies. Rollback subscribes
to store changes synchronously: switching away and back within one React update
still disposes the original request, rather than reviving an old confirmation.

## Recovery comparison evidence

The applied-recovery delta owns its health read, exact-version preview and
rollback intent for one operator, organization, canvas revision and permission
scope. Changing that scope, cutoff, signature or refresh disposes pending work;
synchronous ownership also handles batched away-and-back context changes. A
captured before snapshot is not shown under a different context. Revoking read
access clears the surface and stops its reads.

Health payloads validate the workflow/cutoff, bounded numeric signals, sample
gate, score delta and recurrence references before display. Counts share the same
non-negative safe-integer guard as run, list and dead-letter contracts, without
coercion. Native progress exposes completed samples against the comparison floor.
Rollback fetches both
exact versions and binds the prior immutable ID to the health evidence. Cancel
restores focus to the preview trigger after its asynchronous loading state.

The comparison covers versions **from** the cutoff, not only that version. Its
sample floor counts terminal health observations, not in-flight jobs. Zero matching
failures is neutral observed evidence, never proof of a successful repair. Recurring
failure links use the canonical queue hash route, not an unsupported query key.

## Workflow deployment ownership

Rollout controls own their reads, qualification evidence and pending writes for
one organization, operator, saved workflow and permission mode. Changing that
context remounts the controls and aborts their requests; refresh also invalidates
pending confirmations. A stale confirmation cannot dispatch even if its dialog
was already open. Cancellation does not undo a write the server already received;
the next read is authoritative.

Qualification evidence must match the selected immutable baseline/candidate pair.
Malformed deployment or qualification payloads fail closed with an inline retry,
not an empty deployment or permission to start. The numeric controls retain
native range validation and visible localized labels.

## Bundle budgets

`performance-budgets.json` is a ratchet, not a target: the total artifact,
the worst single-locale artifact, the eager `index.css` stylesheet and the
eager `workflow-workspace` chunk are capped, and every other chunk may grow at
most 10 % over its recorded baseline. The caps moved twice in 2026-09: by the
measured cost of the controller/view splits and the hash router (about
1.5 KiB of gzip for the object keys a model boundary needs), and by the
per-chunk stylesheet split, which trades roughly 12 KiB of total gzip (one
compressed CSS asset per lazy chunk) for 16 KiB less on every cold load. The
cold path is what the caps protect: `index.css`, `workflow-workspace` and the
route budgets in `performance/routes.performance.spec.ts` only ratchet down.

## Closing failures without recovery

Individual, bulk and keyboard DLQ closure share an explicit accepted-loss
confirmation. The dialog snapshots IDs and available workflow/run/step labels;
polling or a changed selection cannot change the acknowledged request. Cancel is
the initial focus, Escape cancels before submission, and submission is guarded
against duplicate activation. While a request is pending, dismissal and competing
queue actions are disabled. Context/permission changes invalidate pending consent.

A partial bulk response keeps failed rows selected for a new acknowledgement.
An unconfirmed or failed closure never advances triage or claims recovery. Closing
uses the existing tenant-scoped API authorization and transition rules; the UI is
not a substitute for either. Accepted loss does not publish the recovered
all-clear celebration or promise undo of external effects.


### Home evidence states

Home derives health from validated production metrics, not the visible run page.
An empty completed-run sample is neither healthy nor failed. First-load errors
are unavailable; retained metrics are explicitly stale during refresh, after
metrics read failures, or five minutes after the last successful full metrics
read (checked by the existing minute clock). Missing required queue, semantic
case or operator-brief evidence (including brief warnings) makes health
unavailable even when the metrics sample succeeds. Missing queue is not zero.
Impact-only polling does not renew the metrics timestamp. Full and impact reads
share request ordering: an older result or failure cannot replace newer impact
evidence. Brief and queue snapshots are scoped to organization and user.
Retry calls the invalidator without forwarding a click event.
Each full, impact and brief request owns an AbortController and aborts on cleanup;
this also bypasses the API client’s short rejected-GET cache so an immediate
retry actually requests fresh evidence. The hero withholds scores,
healthy-history copy and celebrations while evidence is empty or unconfirmed;
known work remains accessible through the action inbox.

A genuinely empty workspace leads with the existing permission-gated controlled
drill and workflow creation actions rather than two empty work cards. No drill
starts on mount; the missing-billing-secret fixture fails before provider egress,
and its validation evidence stays out of production metrics. The entry is not
duplicated in Insights, and dismissing it is session-only. Existing workspaces
with a filtered empty run page keep their operational overview.


### Recovery queue hierarchy

The queue leads with compact organization-wide totals and visibly grouped search,
failure-status, recovery-owner, recovery-severity and sort controls. Totals never
represent the filtered or paginated result; failure status is distinct from the
linked recovery item's progress. Filters keep their existing combined server
query and persistence semantics. Refresh may reorder rows without moving focus
or clearing the selected failure or bulk selection.

Rows retain the fixed 54px height required by virtualization. Controls reflow
without hiding actions at narrow widths; full failure details remain available
below the list. Chromium checks cover long identifiers, English/Spanish labels,
keyboard filter traversal and 390/640/1280 CSS-pixel widths. The 640px case is a
200%-zoom layout proxy, not a screen-reader or physical browser-zoom certificate.
