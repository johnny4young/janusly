# Web frontend

The React 19 application lives in `/web` as a standalone pnpm project. It uses
Vite, TypeScript, Tailwind CSS, Vitest, and Playwright.

Production requests are same-origin. The Go executable serves the embedded
bundle with SPA fallback, one-year immutable caching for hashed `/assets/`, and
`no-cache` for the HTML shell and top-level files. Vite proxies API paths to
`127.0.0.1:3001` during development.

The operator-visible build stamp is injected into the no-cache HTML root and
read by the browser from that document. It is not compiled into hashed JS:
building unchanged frontend source for a new commit must not invalidate every
asset or make gzip budgets depend on the commit ID. The Go binary's verified
commit/tree provenance remains the authoritative runtime identity.

The Go browser boundary applies the CORS allowlist and defense-in-depth browser
headers to API, SPA, and public responses: CSP, frame denial, MIME sniffing
prevention, a bounded permissions policy, and a referrer policy. New browser
methods must also be added to the explicit preflight method list.

The application has one i18n boundary under `web/src/i18n`, one workflow store,
and error boundaries around major workspaces. Accessibility, localization,
browser behavior, bundle budgets, and zero-console-error E2E are acceptance
requirements.

Native React `rules-of-hooks` and `exhaustive-deps` are lint errors. Negative
fixtures prove both rules execute. The stable translator reads a subscribed
runtime locale outside React; a memo that invokes it indirectly must retain
locale invalidation, documented locally when the dependency analyzer cannot
see through that helper. Other missing dependencies are fixed at the hook
boundary rather than hidden with a broad lint exclusion.

New contract-first surfaces use `contractApi` with operation types and
response guards generated from `contract/openapi.json` (see "Browser validation"
in `docs/architecture/api-contract.md`). Authoring additionally checks, in
`web/src/lib/authoring-contract.ts`, that a proposal's workflow can open on the
canvas and that an applicable proposal has complete bindings before it can reach
Apply. Apply also
binds the duplicated intent/recovery contracts and qualification flags to the
exact workflow snapshot, dynamically loading the full strict Recovery Contract
validator only when a reviewed proposal carries recovery policy. The validated
snapshot is cloned before confirmation and catalog refresh so shared UI state
cannot change the object copied into the canvas. Optional experience provenance is
also bound to the draft/catalog and exact source version. A REUSE/ADAPT Apply
revalidates the reviewed receipt and comparison snapshot through the existing
proposal endpoint after confirmation/catalog refresh. A changed source, graph,
consent or canvas blocks copying instead of accepting a new proposal or requesting
generation. Legacy proposals without a source-bearing receipt keep their existing
Apply path. Source Apply supplies its ownership signal to catalog and receipt
reads, bypassing the API wrapper's short dedup window. An expired owner discards
read errors as well as results; aborting the client request does not prove the
server cancelled work. Save and Run remain separate actions.

Saved-version history offers an optional example registry only after a consented,
scoped read succeeds and the operator has AI and workflow read/write grants.
Before that protected read, the UI reads the existing public org-config surface
with the same ownership signal and requires explicit tenant authoring/memory
consent plus the workflow-vector kind. Missing, malformed or disabled consent
hides the registry without making a denied registry request during ordinary
history use. This is UI admission only: the server still independently checks
process gates, permissions and transactional consent on every registry command.
Registration selects an exact immutable history version and explicitly compiles
and reviews an example brief; neither the current draft nor a prompt/graph is
sent to the registration endpoint. Register and Withdraw are explicit mutations.
Disabled consent stays hidden, and failures never grant consent or report success.

Experience review labels REUSE, ADAPT, GENERATE and ESCALATE separately from the
completion/fallback status. It shows the closed reason/policy, exact source
workflow/version for copies, and unknown outcome evidence. The optional name
field requests only `workflow_name`, bounded to 200 UTF-8 bytes; editing it
invalidates the previous proposal and requires a new explicit preview. It never
changes executable graph authority, automatically proposes, or applies work.
An in-flight Apply disables the name input and keeps its detached snapshot.

Saved-version history also observes context changes synchronously. A transient
identity, workflow, saved-state, navigation or authoring grant change aborts its
old page and suggestions and starts a fresh read, even if React batches a return
to the same visible scope. Old success/error paths cannot populate or unlock the
new history snapshot. Client abort remains local result invalidation, not proof
of remote cancellation.

A picked pair of versions, or the draft against its source version, opens over the
author canvas as a read-only merged graph (`VersionCanvasCompare`, loaded on demand).
It reuses `computeWorkflowDiff`, marks steps and paths as new, modified or deleted,
and masks secrets in the before and after JSON as the field diff does. The history
panel owns it through a portal, so leaving the workflow or tab closes it, and
`canvasCovered` turns off the covered editor's keyboard edits while it is open.

The authoring controller and source Apply lose ownership on the first identity,
organization, canvas, navigation or grant change, even if the store returns to
its original values before React paints. Registry results use the saved-history
scope instead: they target immutable versions, so draft canvas edits do not
discard a typed or compiled example. Consent/source resource invalidations expire
registry results, source Apply, a pending preview and an experience-bearing
proposal; an ordinary proposal and Explain/Review/Fix results keep their
canvas-owned lifecycle, and the capability catalog is re-read. Leases are disposed on terminal paths; this is local
result invalidation, not a claim that an already-delivered mutation was cancelled.
The controller observes store transitions synchronously, so a transient identity
change cannot restore an old proposal or capability read. A generation-owned
catalog refresh cannot be populated or unlocked by an older response. Expected
Apply hydration remains valid; resource refresh never substitutes an Apply snapshot
or releases its loading early. Unmount disposes both store and tag observers.

Successful HTTP responses with unreadable bodies are errors, not empty success
objects; cancellation remains `AbortError`. A genuinely empty body remains
compatible with bodyless endpoints. Non-success responses retain their HTTP
status even if error details cannot be read. Before polling mutates run state,
`src/lib/run-status-contract.ts` runs the generated `/status` guard and checks
the invariants the store depends on: every row echoes the run, node and event
ids are unique, and the event cursor is present exactly when more pages exist.
Malformed snapshots leave the previous projection intact; stale requests are
discarded before validation. A later valid poll can recover normally, and
refreshing the latest event page never rewinds already-loaded history.

Recovery AI patch and explicit playbook-use responses cross the generated
guards and then `web/src/lib/recovery-patch-contract.ts` before entering dialog
state. The envelope must carry at least one suggestion the dialog can label and
a recovery passport whose failure signature matches the locally derived
incident; fallback and playbook suggestions keep their fixed confidence.
Persisted workflow identity is added only when absent; an explicit foreign
identity is rejected rather than rewritten. Playbook responses must also match
the requested active playbook, workflow and signature. Evidence is re-scrubbed
once at this HTTP boundary, and the React views consume only the projected read
model. The manifest no longer admits the legacy envelope without `suggestions`,
so there is no legacy projection. Do not add UI for response fields that no
current server route produces.

Snippet insertion imports only the pure insertion helpers and ID prefix; the
built-in recipe catalog and lookup are separate. The menu reads actual built-in
and tenant snippets from the existing API; importing it does not construct a
second unused recipe index. The original library exports and recipes remain
available to explicit catalog consumers.

Live browser validators use `src/lib/schema-lite.ts`, a `zod/mini`-shaped subset
held to Zod by a differential test. Schemas production never reaches keep the
tree-shakeable `zod/mini` entry point.
They must preserve the same strict-object, bound, default, transform, and
refinement semantics as the API contract; do not trade validation coverage for
bundle size. Read-only UI imports shared enums, constants and pure insertion helpers from
separate `*-values` modules; the original contract modules retain and re-export
those values alongside their unchanged validators. Type-only references do not
initialize validators. The metadata editor imports its own `workflow-metadata-schema`
validator without the unrelated collection-write bodies. A pure annotation on an outer schema factory does not
prevent evaluation of effectful argument expressions such as `.check(...)`.
Semantic recovery response parsing lives in
`web/src/lib/recovery-case-contract.ts` and shares the lazy
`recovery-contract` chunk with the workflow recovery validator. It keeps the
case invariants (row echoes, candidate hashes, the approval binding); the React
panel consumes only that read model. Authoring guards are loaded
on demand by workflow commands, keeping the default app workspace below its
immutable budget without weakening the final Apply boundary.

The canvas keeps React Flow identity separate from optional persisted DAG edge
identity. `workflowToGraph` uses a unique local id even for malformed historical
duplicates, carries the original id in edge data, and `getWorkflowJson`
round-trips that original value. Never silently replace a persisted edge id
with an array index: validation and recovery evidence may refer to it.

Recovery queue handoffs bind selection and focus to the requested dead-letter
identity, even when that row is outside the current filtered page. An earlier
clicked row or cached off-list detail must never stand in for a new request.
The panel waits for the exact detail or an explicit not-found result before
focusing it; a queue-level handoff focuses the queue heading. A new handoff
exits bulk selection, while a deliberate row click or keyboard selection
supersedes a pending handoff.

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

Shared runtime guards (`isRecord`, the nullable/optional string guards,
`hasOnlyKeys`, `isStringArray` and the primitives the generated guards compose)
live in `src/lib/guards.ts` only; `scripts/check-duplicate-guards.mjs` (part of
`pnpm lint`) rejects a second definition of any function it exports, whatever
its casing. The generated response guards in
`src/lib/api-guards/` (one module per guard, no barrel) compose the primitives
defined there and are passed to `contractApi` as its `guard` option (see
`docs/architecture/api-contract.md`). The `/org/config` payload has one
reader, `src/lib/org-config-model.ts`. AI Studio and the Inspector load
lazily like every other tab panel: `src/components/panel-loaders.ts` holds one
dynamic importer per tab, `RightPanel` builds its `lazy()` components from
them, and `WorkspaceSectionNav` reuses those importers on hover/focus. On the
canvas tabs `AppWorkspace` renders that navigation in the top bar, lazily from
the `RightPanel` chunk, and `RightPanel` omits it; every other tab keeps it as
the panel's header row. The
`authoring-workspace` group also contains shared dependencies, so its code can
load before an authoring panel mounts. `lazy()` defers mounting, not necessarily
transfer; a second destination-level preload effect is unnecessary. First-open
navigation uses the Suspense fallback if its import is still pending. Small helpers
shared only by lazy list surfaces are coalesced in `lazy-ui`; recovery-only models,
status primitives and evidence helpers are coalesced in `recovery-ui`. Neither
group belongs on the cold shell path. This avoids one gzip/import boundary per
micro-module without merging the independent panel chunks operators navigate to.
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
Dialogs normally get Escape from `useDialogFocusTrap`'s `onEscape` option.
Recovery keeps its state-specific Escape guard so in-flight saves and rejection
feedback cannot be bypassed. It retains focus on its dialog root when an
asynchronous step replaces the active button; Tab and Shift+Tab stay within the
modal, including busy steps with no enabled controls. The initial Generate
action may receive focus, but the validated Apply action never gains focus
automatically after a sandbox response.
Every product action is the `Button` primitive (`components/ui/Button.tsx`):
`size="sm"` for inline row and toolbar actions, `variant="primary"` for the
one action a surface leads with, `variant="danger"` for destructive ones,
`size="icon" variant="ghost"` for icon-only controls, and `aria-pressed` for
toggles (the primitive styles the pressed state). The legacy `small-command`
and `icon-button` classes are gone from buttons; raw `<button>` remains only
for non-action semantics — tabs, radios, list rows, chips — that carry their
own component styles. Action menus use `Menu` (`components/ui/Menu.tsx`): arrow
keys, Home/End and optional single-key shortcuts move or select, Escape and Tab
close and return focus to the trigger, and fixed positioning keeps the menu
visible inside tables that scroll.

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

The shell presents four stable top-level task spaces: Home, Workflows,
Activity and Settings. A routed section remains visible as location context
even when it is intentionally omitted from the compact section rail: the top
bar renders destination then section, and the rail introduction names the
exact section with its own helper copy. For example, `#/recover` reads as
Activity / Recover, and a recovery-case route resolves to the same Recover
context. Reloading or browser navigation must preserve both the route and that
context; grouping a section never makes its deep link anonymous.

Activity shows the tabs Runs, Recover (with its open count), Agent activity and
Reports, each filtered by the permission that opens it. Reports (`#/reports`,
`recovery.read`) is a lazy panel with a 7, 30 or 90 day window. KPIs, failure
clusters and the Value dashboard read `/recovery/metrics` and `/dlq/clusters`
for that window behind `dlq.read`; windowed Recovery validation and every export
need `reports.read`; the heatmap, ledger and wins come from `/recovery/home`,
whose 90-day heatmap the panel narrows to the window. An operator without
`dlq.read` or `reports.read` reads those reports from the same `/recovery/home`
sections, which `recovery.read` allows: fixed at 30 days (90 for the heatmap),
with no window control and no exports. Model calibration and AI spend
are not windowed: their endpoints have no window parameter. A heatmap day opens
Recover through `#/recover/day/<YYYY-MM-DD>`.


Recover keeps its filters above two panes once the queue section is at least
760 px wide: the queue on the left and the selected failure on the right, each
scrolling inside a height tied to the viewport. Narrower sections stack them, and
selecting rows gives the queue the full width. A row's recovery item drawer opens
in the detail pane. The default By cluster view groups
the loaded rows client-side with `normalizeErrorSignature`, the normalizer the
server clusters with, so every filter, sort and page keeps applying.
`/dlq/clusters` only adds the totals on each header: a signature outside its
30-day window, or a failed read, still groups from the loaded rows. Headers and
rows share one fixed height, so the queue stays virtualized in both views, and
J/K and triage focus walk the rows in the order shown.
Investigate and Replay cluster read `/dlq/cluster-members` when clicked and open
the cluster recovery and campaign dialogs. The full rollup, with failed run nodes
and suggested owners, remains under Automation and patterns.
