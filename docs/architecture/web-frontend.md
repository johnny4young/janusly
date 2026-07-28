# Web Frontend (canvas/layout, web deps, i18n, Recovery Center, inspectable AI)

> Operational deep-dive extracted from `AGENTS.md` (kept verbatim). `AGENTS.md` carries the one-line summary + a link here. Edit the invariants here; keep the `AGENTS.md` summary in sync.

**External runtime shadow administration:** Operations → Integrations mounts
`ExternalRuntimePanel` before action-capable integrations. It accepts only the
server's explicit `observerOnly: true` projection, validates every connection,
run, and case row before rendering, and filters its credential picker to
`external_runtime_signing_secret`. The card keeps the no-control boundary
visible, shows signed callback metadata plus detected/observed-recovered case
counts, and exposes only create/delete/copy for observer configuration—never
retry, resume, cancel, replay, or recovery-credit controls. Reader permission
hides configuration mutations; administrator mutations invalidate the shared
platform snapshot through `bumpPlatformVersion()`. Keep the responsive EN/ES
layout and malformed-wire fail-closed behavior covered.

**Slack interaction administration:** Operations → Integrations mounts `SlackInteractionsPanel` before credential health and MCP connections. It lists only the server's safe projection (name, team id, signing credential name, bounded user mappings, enabled state, and callback URL), filters the credential selector to `slack_signing_secret`, and maps Slack user ids to members returned by `/members`. It supports create/edit/delete/copy with responsive EN/ES controls and invalidates other panels through `bumpPlatformVersion()`. Recovery alert policies show the optional interaction-connection selector only for Slack channels on recovery-item triggers; all other Slack alerts remain text-only.

**Progressive workflow deployment:** the Inspector lazily mounts `WorkflowRolloutPanel` for saved workflows. It reads immutable version history plus the latest deployment projection, permits an older baseline against only the newest canary, and bounds canary traffic/minimum sample/minimum success rate to the server contract. Active state shows traffic, baseline/canary terminal counts, canary success rate, and the automatic-return guardrail. Promotion and return-to-baseline use the shared accessible confirmation dialog; successful mutations call `bumpPlatformVersion()`. API payloads are parsed defensively instead of trusted through casts. Eligibility, authorization, trigger compatibility, assignment, and automatic rollback remain server-owned; the panel is not a second deployment state machine.

## Layout & canvas visibility

**Layout & canvas visibility:** the React Flow canvas (`apps/web/src/components/WorkflowCanvas.tsx`) is the most expensive component in the web bundle and only meaningful in authoring contexts. The closed-enum allowlist `CANVAS_TABS = ['copilot', 'inspector'] as const` in `apps/web/src/types.ts` is the SINGLE source of truth for which tabs SHOW the canvas in their main slot. `App.tsx`'s slot dispatcher consults `getCanvasVisibility(activeTab)` (same file as `CANVAS_TABS`) and follows three closed states: (a) `home` → `mounted: false`, `<RecoveryCenterPanel>` owns the full slot (no canvas in the DOM at all, so users who never navigate away from home pay zero React Flow runtime cost AND zero React Flow download — the renderer is code-split, see below); (b) canvas tab (`copilot` / `inspector`) → `mounted: true, visible: true`, the canvas wrapper is visible and `<RightPanel>` mounts in the side panel; (c) any other non-home tab → `mounted: true, visible: false`, the canvas wrapper stays in the DOM hidden via `.workspace-canvas-wrapper[data-canvas-visible="false"] { display: none }` AND a `<div data-layout="contextual">…</div>` sibling renders the `<RightPanel>` content in the full-width main slot with `panel={null}`. The hidden-but-mounted posture is load-bearing: `<ReactFlowProvider>` lives inside the lazy-loaded `apps/web/src/components/CanvasWorkspace.tsx` (relocated from `main.tsx`) so `@xyflow/react` — the bundle's single heaviest dependency (~182 KB JS + 15 KB CSS) — is code-split into an on-demand chunk that stays OFF the boot/home-landing path; `App.tsx` renders `<CanvasWorkspace>` via `lazy()` + `<Suspense>` (reusing the `common.working` fallback) INSIDE the `workspace-canvas-wrapper`. Because `getCanvasVisibility` keeps the wrapper `mounted: true` for EVERY non-home tab, the `<ReactFlow>` instance — and thus the viewport (zoom + pan) — survives `inspector → operations → inspector` cycles in-memory (the instance is never destroyed). A round-trip THROUGH home (`mounted: false`) unmounts the canvas, but for a SAVED workflow the viewport is RESTORED on the next mount from `localStorage` (`apps/web/src/canvas-viewport.ts`, key `janusly:canvasViewport:<workflowId>`): `WorkflowCanvas` reads it as `defaultViewport` so `fitView` is skipped (`fitView={!restored}` — React Flow ignores `defaultViewport` while `fitView` is on) and persists user pan/zoom via `onMoveEnd` plus explicit React Flow `Controls` callbacks (`onZoomIn` / `onZoomOut` / `onFitView`). Only deliberate gestures are stored — the automatic fit/restore fires `onMoveEnd` with a null `event`, which is skipped; the toolbar callbacks persist Control Panel zoom/fit because React Flow reports those viewport changes with a null source event too. An UNSAVED draft has no reload-surviving identity, so it always `fitView`s (no persistence). The chunk loads on the operator's FIRST non-home navigation (canvas tab OR a hidden-canvas tab like operations — both mount the wrapper). To keep it deferred, NOTHING on the boot path may import an `@xyflow/*` VALUE: the store's React Flow change-appliers (`applyNodeChanges` / `applyEdgeChanges` / `addEdge`) are registered lazily from `CanvasWorkspace` via `registerFlowOps` (store.ts keeps only the type-only `@xyflow/react` import), `canvas-projections.ts` uses the marker string literal `'arrowclosed'` (type-only `EdgeMarker` import), and `vite.config.ts`'s `manualChunks` early-returns `undefined` for `@xyflow/` so the loose `/react/` matcher can't sweep it into the eager `react-vendor` chunk. The CSS rule `.workspace-main > [data-layout="contextual"]` (in `apps/web/src/styles/foundations.css`) centers + pads the contextual wrapper to `--we-content-max-width: 1280px`, mirroring the Recovery Center hero. Non-canvas non-home tabs gain full main-slot width without the authoring DAG sitting behind their admin/read-only content, except for the explicit run-observation companion described below. The `onNodeClick → setActiveTab('inspector')` cross-reference in `App.tsx` is safe because `'inspector'` is in `CANVAS_TABS`. Adding a new tab that needs the canvas means appending to `CANVAS_TABS` (one line); any other tab gets the contextual full-width layout AND the hidden-canvas viewport-preservation for free. A page reload (F5) likewise restores a saved workflow's viewport from `localStorage` (an unsaved draft is discarded by F5 anyway and re-fits). Persistence is per-browser and gated on `currentWorkflowSaved` (App passes `viewportWorkflowId={currentWorkflowSaved ? currentWorkflowId : undefined}` to `<CanvasWorkspace>`, which threads it to `WorkflowCanvas`, and keys the canvas by `currentWorkflowId` so React Flow remounts when the operator opens a different saved workflow and can re-read `defaultViewport`); cross-device sync and pruning orphan entries for deleted workflows are out of scope.


**Authoring persistence:** the shared workflow contract may carry an optional node `label` (operator-authored display identity, max 80 characters) and `ui.positions` keyed by node id. Runtime dispatch remains exclusively `node.type`; engine consumers ignore `ui`. Positions retain React Flow's established top-left origin so historical fallback coordinates keep their visual meaning. `graphToWorkflow` persists every finite React Flow position, while `workflowToGraph` restores positions per node and uses the deterministic diagonal fallback only when a historical node has no persisted coordinate. A completed drag marks `workflowDirty` so versioned save and local draft autosave capture layout, but it deliberately does NOT increment the semantic `workflowRevision` used to invalidate readiness and AI findings. Palette placement stays inside the lazy canvas: `WorkflowCanvas` registers a viewport-centre resolver through `registerNodePlacementResolver` and estimates the rendered node footprint from an existing sibling before resolving the top-left coordinate; the boot-reachable store must never import a React Flow value. The empty-selection Inspector owns direct top-level object input/output authoring; its `WorkflowIoEditor` is locally lazy-loaded so this secondary form does not grow the boot entry, and a non-object root schema is preserved read-only rather than flattened destructively.

**Guided authoring interactions:** both authoring tabs expose the same compact canvas palette, while the complete sidebar palette remains the source for every registered node type. Palette buttons retain their click behavior and additionally publish an HTML drag payload containing ONLY the node type; `WorkflowCanvas` validates that value against the closed `nodeTypes` catalog, accepts drops only on the React Flow interaction surface (never the palette, summary toolbar, controls, or MiniMap), lets the empty-canvas teaching card pass first-use drops through, converts the pointer to a top-left flow coordinate with the same rendered-footprint resolver used for centered insertion, and lets the store apply the canonical preset. Node duplication is store-owned, copies durable node data/config only (never React Flow measurement or selection fields), offsets the copy, selects it, and intentionally does not copy edges. The interactive React Flow MiniMap appears only on authoring graphs with at least six nodes; observation graphs remain immutable and never render it. The Inspector's subworkflow input uses an editable `datalist` backed by the already-loaded, tenant-scoped active workflow page: it excludes the current workflow from suggestions, marks an already-configured direct self-reference invalid, and keeps manual entry plus clearing available because the loaded page is bounded and cannot be treated as the complete tenant catalog. Its adjacent optional version field accepts only integers in the persisted PostgreSQL range, explains exact-pin versus latest-at-run-time behavior, and removes the old pin whenever the operator changes the child workflow id so a version number cannot silently cross child identities. The starter graph is an executable HTTP → condition → approval example: the condition reads the HTTP executor's `statusCode`, and the approval edge runs only when the condition output is true. Global Help opens the shared shortcut dialog; Cmd/Ctrl+1 and Cmd/Ctrl+2 switch to Home and AI Studio, respectively. These interactions must stay inside the existing lazy canvas boundary and may not add a browser-side workflow or cron parser dependency.

**Loop authoring:** the Inspector preserves omitted/default `map` behavior and exposes `for_each` as an explicit mode with the existing registered-tool picker, per-item JSON input, concurrency 1..20, and one count-or-percentage failure budget. Switching budget units removes the inactive key, fractional percentages remain exact, and legacy mapping stays in config when the operator temporarily selects tool execution. EN/ES labels and browser coverage live in the same lazy authoring boundary; do not duplicate the tool catalog or create a web-only validation model.

**Run observation exception:** Runs and Reasoning remain NON-authoring tabs and MUST NOT be added to `CANVAS_TABS`. When an active run contains a valid `runs.input_json.workflow` snapshot, their contextual slot switches to `data-layout="run-observation"`: a separate `RunObservationWorkspace` React Flow provider renders that exact snapshot beside the operational panel. `getRunWorkflowSnapshot` and `workflowToGraph` in `canvas-projections.ts` validate historical JSON fail-closed, restore persisted positions when present, and use the established deterministic layout as the per-node fallback; `projectVisibleNodes` overlays only the active run's `run_nodes` statuses. The selected detail snapshot is retained independently from the bounded `/runs` page, so refreshes and newly started runs cannot make the map disappear. Async run ownership binds both the active run id and a monotonic `runTransitionGeneration`; identity, workflow, and active-run transitions increment that generation atomically with projection cleanup. Open/start guards and status/history requests capture it before awaiting, then fail closed if either owner changes; discarded polling responses also skip connection and terminal lifecycle effects. `WorkflowCanvas mode="observe"` disables drag/connect/reconnect/delete, hides handles, keeps pan/zoom/focus, labels nodes with localized status for assistive technology, pulses `running` nodes, and replaces that motion with a static ring under `prefers-reduced-motion`. This is deliberately a SECOND provider/instance: the hidden authoring canvas stays mounted and untouched, so observing a run can never mutate the draft, select an editor node, or replace the saved authoring viewport. Runs/Reasoning without a valid active snapshot keep the normal full-width contextual layout. At ≤1200px the observation map stacks above the panel; wider desktop windows keep both side-by-side.

**Run workspace:** the primary Runs destination mounts `RunWorkspace`, which composes the existing `RunsPanel`, `ReasoningPanel`, and `MultiAgentTimeline` projections behind accessible Overview / Timeline / Agents tabs. It consumes the active run data already owned by `App` and MUST NOT introduce another fetch or run-identity authority. Arrow keys plus Home/End implement roving tab focus; Timeline and Agents remain disabled until a run is active, and an active-run identity change resets the selected inner view to Overview before the new run can render. The primary sidebar exposes only Runs for this evidence; the full Reasoning and Multi-agent tabs remain stable expert routes through the command palette and explicit full-view actions. Keep those direct routes compatible with persisted `ActiveTab` state, but do not restore Multi-agent as a second primary sidebar destination.

**Task-space navigation:** the persistent sidebar exposes exactly six primary
destinations: Home, Recover, Workflows, Runs, Connections, and Operations.
Specialized AI Studio, Experiments, Step setup, Recipes, Packs, Tools, and Team
destinations remain in an Advanced group that is collapsed by default and
remain directly reachable from the command palette. The workflow identity
card, AI status strip, and complete node palette render only for the two
authoring tabs (`copilot` and `inspector`); operational destinations never
carry unrelated draft controls. Workflows keeps a visible New workflow action
that routes authorized users into AI Studio and remains disabled when
`workflows.write` is absent. Persisted sidebar groups are filtered through
the current closed group catalog, and a non-empty legacy group list that
contains no current keys falls back to the open Workspace group. Runs owns
execution history, active-run evidence, usage, explanations, and sandbox
forks. Recover owns waiting human actions, failed-node actions, and the
dead-letter/replay queue. Both projections consume the same App-owned run
state; Recover is not a second polling or run-authority path.

## Web deps

**Web deps:** `apps/web` only imports `react`, `react-dom`, `@xyflow/react`, `@supabase/supabase-js`, `zustand`, `lucide-react`, `i18next`, `react-i18next`, and focused zero-dependency `@janusly/shared/src/*` subpaths. `status`, `workflow-diff`, `expression`, `recovery-autonomy`, `technical-recovery-autonomy`, and `recovery-passport` are canonical runtime grammars or pure projections shared with the server; never fork web-only evaluators for them. Do not import the broad `@janusly/shared` barrel from web; it pulls workflow Zod schemas into the browser bundle. No `@radix-ui`, `class-variance-authority`, `clsx`, or `tailwind-merge` — the design system is hand-written CSS behind the ordered `index.css` entrypoint. Don't reintroduce shadcn-style scaffolding. **CSS architecture:** `index.css` imports `foundations.css`, `control-plane.css`, `workflow.css`, `platform.css`, and `accessibility.css` in that exact order; later modules intentionally refine earlier primitives. `foundations.css` owns `@theme`, runtime aliases, and `--we-radius-pill`. Runtime cards use the single `.we-card` base; pills use `.we-pill` plus the closed `data-tone="info|warning|neutral|ghost|primary|danger|success"` vocabulary instead of modifier-class aliases. `scripts/check-css-classes.mjs` scans every CSS module plus production TypeScript literals and fails `pnpm lint` on any selector without a production owner; React Flow's external class namespace is the only prefix exemption. **`i18next` + `react-i18next` are allowed exclusively for i18n integration through the `apps/web/src/i18n/` module; component code never imports from `i18next` / `react-i18next` directly — every consumer goes through `useT()` / `t()` / `tValidationIssue()` / `tReadinessIssue()` / `tAiReviewIssue()` / `tRunEvent()` / `tFailureCluster()` / `tApiError()` / `getResolvedLocale()` exported from `apps/web/src/i18n`. Pinned at `i18next@^26` + `react-i18next@^17` so the stack stays in sync with the sibling `lingua` project.** **App/dialog decomposition (structure of record):** `App.tsx`'s bootstrap + effects live in named hooks under `apps/web/src/hooks/` — `useBootstrapData` (the platform `Promise.allSettled` fetch + `refreshPlatform`, fired on `authReady`), `useRunPolling` (the 1500ms `/status` poll + `loadStatus` + terminal cascade; keeps the SSE-skip-while-`streamTransport==='sse'` + `addEvents`-merge invariants), `useKeyboardShortcuts` (the global keydown listener). Every callback passed into those hooks is `useCallback`-stable so the poll interval / keydown listener don't rebind per render. `RecoveryDialog.tsx` is split into prop-driven bodies + pure helpers under `apps/web/src/components/recovery-dialog/` (`types.ts` / `helpers.ts` / `RecoveryPassportCard` / `EvidencePanel` / `ReviewBody` / `CancellingBody` / `ValidationFailedBody` / `AppliedBody`); the parent keeps the `Step` state machine, the focus/ESC/validation-poll effects (including the double-transition `cancelled`-before-yield guard), and the explicit validate-then-apply callbacks. The onboarding checklist is mounted contextually inside `RecoveryCenterPanel`, never in `App.tsx`'s overlay slot; it may not use fixed positioning or obscure incident controls. Mirror the `recovery-center/` precedent (subdir of focused pieces, hooks in `hooks/`, no barrel files); don't re-inline these back into the parent.

The Reasoning tab and the Runs workspace's Timeline projection share the lazy `ReasoningPanel` chunk rather than placing it on the eager `App` path. Its `constants` and `useVirtualList` dependencies are shared chunks because Runs history also consumes them; keep the three reviewed names in `apps/web/performance-budgets.json`. Do not move the long-run timeline back into `RightPanel.tsx` or `RunWorkspace.tsx`: the feature-specific filtering, focus navigation, payload rendering, and fixed-row virtualization belong in the sibling component, while the wrappers remain lazy dispatchers.

The zero-dependency `@janusly/shared/src/api-contract` subpath is also allowed:
it is the canonical exact-path catalog for reads transported over `/v1` and
prevents the browser from maintaining a second list beside OpenAPI. Do not
replace it with a broad `@janusly/shared` barrel import.

## Startup loading boundaries

The production entry may contain boot infrastructure, but not either full
translation catalog or the Supabase implementation. `bootstrapI18n()` awaits
only the resolved local catalog before React mounts; explicit
`catalog-en.ts`/`catalog-es.ts` modules keep the chunks separately named, and
`changeAppLanguage()` demand-loads the other catalog before persisting the new
preference. Catalog parity allows `fallbackLng: false`, so a Spanish first
render does not quietly download English. This remains local-file loading—not
an i18next backend—and React Suspense stays disabled. Supabase is reached only
through the dynamic `supabase-runtime.ts` boundary described in
`auth-and-identity.md`; dev headers and SSO remain on the lightweight path.
`routes.performance.spec.ts` is the runtime conservation gate: Home must load
exactly the selected catalog, must not load Supabase when unconfigured, and a
real locale switch must fetch the second catalog. The matching bundle budget
keeps entry JavaScript at 8 KiB gzip and Home at 300 KiB transferred; do not
raise either cap without a measured, reviewed reason.

## Render-error blast radius

`ErrorBoundary` (`apps/web/src/components/ErrorBoundary.tsx`) is the single
render-error boundary: a class component, because `getDerivedStateFromError`
has no hook equivalent. It wraps three surfaces — the React Flow canvas
(`WorkflowCanvas.tsx`), every tab panel (the one `RightPanel` mount point, so a
new tab is covered without extra wiring), and the Recovery Center home surface
(`App.tsx`, which renders outside the panel router).

Panels render whatever the API returns, so a section dereferencing an
unexpected envelope must cost its own card and nothing else. Without a
boundary the throw unmounts the entire tree and the page goes blank — that is
an observed failure, not a hypothetical: `RecoveryValidationSection` reads
`report.totals` unconditionally and blanked the whole workspace when
`/recovery/validation` returned an unexpected shape.

A tripped boundary stays in its fallback until something clears it, so both
hatches must stay wired:

- `resetKey` — the canvas passes the workflow id, panels pass the active tab.
  Clearing happens through `getDerivedStateFromProps` rather than a remount, so
  a healthy subtree keeps its React Flow viewport and scroll position.
- the render-prop `fallback`, which receives `reset` for an in-place retry.
  Panels use `PanelErrorFallback` (retry) because they usually trip on a single
  bad payload; the canvas keeps its reload fallback.

Failure copy goes through the i18n chokepoint (`panel.error.*`) like the rest
of the UI. `logTag` prefixes the diagnostic console line (`panel:runs`,
`canvas`) so a caught error is attributable in a bug report.

## Modal focus contract

Every surface that can expose `aria-modal=true` uses `useDialogFocusTrap`, a
`dialog`/`alertdialog` role, and an accessible name. The hook is the single
owner of trigger capture, optional initial focus (`true` for the first
focusable control or a preferred ref with a focusable fallback), Tab wrapping,
React Strict Mode replay safety, and trigger restoration. Each component keeps
its own Escape/backdrop behavior and state machine; do not move those semantics
into the generic hook. `apps/web/src/modal-contract.test.ts` inventories the
true modals and fails when a new one bypasses this contract. Deliberately
non-modal drawers such as `RecoveryItemDrawer` retain `aria-modal=false` and
their independent close/restore behavior — trapping them would make background
content incorrectly inert.

## Automated accessibility floor

`apps/web/e2e/accessibility.spec.ts` runs `@axe-core/playwright` against the
real end-to-end stack and blocks serious or critical WCAG 2.0/2.1/2.2
violations in the highest-value settled states: Recovery Center plus its queue,
AI Studio plus the command palette, mobile navigation, and Spanish dark mode.
The helper finishes finite entrance animations before analysis so opacity
transitions cannot create transient contrast failures; infinite ambient
animations remain untouched. Each journey also rejects browser console/page
errors and can write deterministic screenshots through
`JANUSLY_EVIDENCE_DIR`. This automated floor complements rather than replaces
the focused keyboard, focus-restoration, reduced-motion, and semantic tests for
each component.

## i18n

**i18n:** the `apps/web/src/i18n/` module is the single chokepoint for translations. Two locales today (`en`, `es`) plus a `'system'` setting that resolves once at boot via `navigator.languages`. Persistence: `localStorage["janusly:locale"]` (defensive try/catch mirroring `auth.ts`). Bootstrap: `apps/web/src/main.tsx` awaits `bootstrapI18n()` for exactly the resolved local catalog before `createRoot`; initialization then stays synchronous, with no Suspense and no remote i18next backend. JSON catalogs live at `apps/web/src/i18n/locales/<lng>/common.json` (single namespace `common`, dot-notation flat keys, plurals via i18next `_one`/`_other`, interpolation `{{var}}`). Application code receives the bounded `Translate` signature `(key: string, options?) => string` rather than i18next's recursive generic `TFunction`; this keeps TypeScript 7 from exhausting its instantiation depth and correctly permits plural base keys plus dynamic catalog families. Catalog completeness is enforced by parity and runtime fallback tests, not an exact-key union that cannot model those i18next behaviors. React components use `useT()` (subscribes to language changes), while non-React helpers (`constants.ts` formatters, server-event mappers) use `t` from `apps/web/src/i18n/runtime.ts` (shares the same `i18next` instance). Server-emitted strings are translated client-side via the dedicated helpers `tValidationIssue` / `tReadinessIssue` / `tAiReviewIssue` / `tRunEvent` / `tFailureCluster` / `tApiError` — they look up `<surface>.<code>` in the catalog and fall back to `serverEvents.fallback` (`{{message}}`) for unknown codes. **API error envelopes** ship `{ error: "<EN fallback>", code: "<snake_code>", params? }` built via `errorEnvelope(code, message, params?)` from `apps/api/src/error-codes.ts` (closed `ApiErrorCode` union); `tApiError(err)` on the web reads the `code` first and resolves `apiErrors.<code>` in the catalog, falling back to the literal `error` (then `message`) when the key is missing. Adding a new API error code is three edits: the closed-union entry in `error-codes.ts`, an `apiErrors.<code>` line in `en/common.json`, and the matching line in `es/common.json` (parity test catches mismatches). **Date and number formatting** in components passes `getResolvedLocale()` to `.toLocaleString()` / `.toLocaleDateString()` so timestamps and counts respect the operator's UI language; never call those formatters without an explicit locale argument. The server stays locale-blind; the client owns 100% of translations. Adding a new code from the engine is one entry in `en/common.json` + `es/common.json`; adding a new locale requires its `locales/<lng>/common.json`, one explicit `catalog-<lng>.ts` loader, and the closed loader-map entry. Parity between locales is gated by `apps/web/src/i18n/parity.test.ts` (runs as part of `pnpm test`). Free-form server messages (Supabase errors, generic `Error.message`) pass through `serverEvents.fallback` unchanged.

## Recovery Center (home tab)

**Recovery Center (home tab):** the authenticated landing page is `activeTab: "home"` (set in `apps/web/src/store.ts`), rendering `RecoveryCenterPanel` from `apps/web/src/components/RecoveryCenterPanel.tsx`. Its primary server read is the coalesced `GET /recovery/home`, whose independent section envelopes contain metrics, semantic cases, clusters, heatmap, validation, lifetime ledger, personal wins, and the authoritative queue overview; run nodes still come from the App-owned store. The server reuses the same read models as the focused legacy endpoints, so Home cannot drift into a second metrics or clustering implementation. A failed section returns `status: "unavailable"` without erasing successful siblings. The browser parses the outer envelope defensively, maps unavailable sections to their established local fallback, and retains the semantic-case `loading | available | unavailable` posture plus known cases through refresh failure. The global recovery CTA unions open-quarantine run ids with waiting runs from the bounded bootstrap projection plus the selected-run node fallback, so independent projection timing can never render `All clear` while semantic containment is visible. Every browser snapshot carries the organization and, for personal wins, the user that produced it; a tenant or identity switch neither renders nor accepts an earlier owner’s result. `platformVersion` and terminal run-stream events invalidate the full snapshot immediately. A visibility-aware `GET /recovery/home?scope=impact` fallback refreshes only ledger, personal wins, and queue every 10 seconds while failures remain open, every 60 seconds while healthy, never while the document is hidden, and once on foreground. This keeps missed-event and Redis-degradation recovery without repeatedly executing the heavier metrics, clusters, validation, semantic-case, or heatmap projections. Isolated rail tiles may own distinct read-only endpoint fetches when their data is not part of the Home envelope — `BudgetTile` uses `/billing/budget` and `CalibrationHealthTile` uses `/recovery/calibration-status`, both refetching on `platformVersion` and rendering a non-blocking local error state. The deterministic `computeRecommendedActions(signals)` helper prioritises operator-blocking work first (pending approvals → cluster recover-all → triage → review risk → getting-started → healthy-try-studio); approval and triage actions open Recover, while execution trends open Runs. The `newWorkflow()` reset in the store INTENTIONALLY routes to `"copilot"` (AI Studio) so the canvas opens when drafting starts — don't change that to `"home"` or the new-workflow flow regresses. Animations (count-up + HealthRing stroke) honour `prefers-reduced-motion: reduce` via the shared `useAnimatedNumber` hook + CSS media-query overrides on `.we-recovery-center-ring__arc` / `.we-ops-metric-card--button` transitions. Three responsive breakpoints (1100/760/480) reflow the shared `<VitalSignsStrip />` + tile grid; the 480px breakpoint enforces ≥44px tap targets on the action CTAs. The small SVG `<HealthRing />` stays local to the home tab; cross-surface metric tiles use `<VitalSignsStrip />` across Home + Operations instead of a second bespoke metric primitive.

The semantic-case tile is deliberately a compact triage surface rather than a
form. Its Review/Resolve action opens the lazy contextual
`RecoveryCasePanel`, which fetches the stable tenant-scoped detail contract and
shows the finding, bounded evidence, chronological transition receipts, run
deep link, and effective autonomy Recovery Passport. The policy card renders
the Level 0–4 capability ladder from the server profile rather than deriving
authority in the browser; replacement controls appear only when
`applyWithApproval` is enabled, while accepted loss remains available for an
explicit closure. The contextual case id is
not included in `PERSISTED_TABS`; refreshing or changing identity returns to a
safe top-level workspace rather than restoring a case without authority or
context. The panel parser rejects malformed case or receipt envelopes in full,
date formatting follows live locale changes, and read-only users retain the
evidence view without mutation controls.

Recovery time copy delegates to `formatDuration` in `recovery-center/helpers.ts`; the legacy `formatDowntime` export is only a compatibility wrapper, and relative ages use the same core with runtime locale keys. Recovery Center and Operations route recovery-time selection through `selectRecoveryTimeMetric`: prefer the versioned production-only `verifiedRecovery` median and use legacy average `mttr` only when an older API omits the new field. The selectable trend is a per-day median over the same eligible production impact events. Sparkline points and selectable heatmap cells are composite keyboard controls with one roving tab stop: arrows plus Home/End move focus, and Enter/Space/click publishes the existing recovery-day handoff before opening Recover. Keep the sparkline point targets as siblings of the metric's main button (never nest interactive SVG controls in a button), keep empty heatmap days non-actionable, and keep unlabeled sparklines decorative. The truly-fresh Recovery Lab entry waits for a successful metrics section before exposing dismissal; its dismissal lives in the Zustand session state and resets when the auth owner or organization changes. It presents no fabricated incident, transcript, score, timing, or cluster evidence. The operator must explicitly start a controlled solution-pack drill, whose run is tagged as validation data and excluded from production rollups, before Janusly creates any recovery activity. Do not persist dismissal to `janusly:recovery:hideIntro` until the Home metrics section reports real terminal history, so a fresh-workspace reload restores the truthful lab entry.

**Replay-campaign UI:** `DeadLettersPanel` exposes paced campaign creation only from multi-select, with the server preview shown before the operator can submit. `ReplayCampaignDialog` uses the shared modal focus contract and never derives cohort eligibility in the browser. `ReplayCampaignsCard` renders the eight newest durable campaigns, polls every three seconds only while at least one is running, refreshes on `platformVersion`, and requires inline confirmation before cancellation. Progress is the server's settled counter (`replayed + failed + cancelled`) over the immutable total; it must not infer success from queue acceptance. The surface stays bilingual and usable at 390px without hiding the stop control. An empty campaign list renders no placeholder card so ordinary recovery triage does not gain permanent visual weight.

## Inspectable AI guidance and decisions

Operator AI policy has two bounded bilingual editors. `AiGuidanceSettingsPanel` lives in Operations → Reliability and reads/writes the closed `ai.operatorGuidance` organization setting through the existing `/org/config` routes. `WorkflowMetadataPanel` owns the optional per-workflow `aiGuidanceMarkdown` field through the existing whole-row metadata route. Both show a UTF-8 byte counter, explain that the field is preferences rather than a secret store or policy override, prevent an over-cap save, and call `bumpPlatformVersion()` after success. Do not introduce a second settings endpoint or persist the text in browser storage; the tenant-scoped server writers and their audit-safe descriptors are authoritative.

Recovery keeps model-authored trade-offs and deterministic support visibly separate. `AlternativeHypothesesPanel` is a collapsed-by-default disclosure after the workflow diff and before `EvidencePanel`; it consumes only the unknown-safe normalized zero-to-two `consideredAlternatives` rows and hides when none survive. `ReasoningPanel` renders a valid `agent.reasoning` payload as a compact operator summary (why, mode, agent, decision/tool, iteration), with only that closed, scrubbed projection behind the raw-JSON disclosure. Malformed canonical events fail closed to localized unavailable copy and never render their raw payload. `dedupeAgentReasoningEvents` hides only the nearest matching legacy `*.step.planned` row inside `ReasoningPanel`; `MultiAgentTimeline` continues to consume the legacy event unchanged, so the additive event cannot create phantom agent steps. Labels and controls are localized EN/ES; model-authored/free-form reasons remain bounded data rather than hidden chain-of-thought.

The technical DLQ Recovery Passport uses the shared pure
`@janusly/shared/src/recovery-passport` evaluator. It always renders five
structured factors—candidate, sandbox, effect risk, approval, and evidence—as
pass, review, or block. Model confidence remains an informational fact and
never changes the deterministic verdict. Blocking factors dominate review
factors; a safe verdict requires every factor to pass.

## Memory governance transparency

`useMemoryConsentStatus` is the tenant-identity-safe read chokepoint for
`GET /memory/consent-status`; malformed or failed reads render an explicit
unavailable state and never infer consent. Operations → Access mounts the
read-only `MemoryGovernancePanel`, showing the process gate, tenant gate, and
the safe purge projection (`none` / `scheduled` / `running` / `unknown`). When
tenant consent is off and deletion is scheduled, Recovery Center shows a
whole-minute countdown and deep-links to that panel; re-granted consent hides
the warning even if a best-effort cancellation left a job visible, because the
worker re-checks consent before deleting. `AuditLogPanel` owns the `memory.`
quick filter and a scroll-safe wrapped table for the resulting grant/revoke and
purge actions. Keep all three surfaces bilingual and org-bound; the hook must
not render a previous tenant's snapshot while a new request is pending.
