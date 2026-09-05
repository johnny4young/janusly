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
reader, `src/lib/org-config-model.ts`. AI Studio and the Inspector stay in
the eager workspace chunk on purpose: splitting them fans their shared helpers
into small chunks whose wrapper overhead costs more total bytes than the split
saves, and the artifact budget counts every chunk; the per-route win waits for
the stylesheet split. `RightPanel` and `AppWorkspace` are memoized, and the shell's derived counts
are memoized on their inputs, because the shell renders on every store tick.
Dialogs get Escape from `useDialogFocusTrap`'s `onEscape` option rather than
their own keydown effects.

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
