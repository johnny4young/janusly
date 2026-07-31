# Web Frontend (canvas/layout, web deps, i18n, Recovery Center, inspectable AI)

> Operational deep-dive extracted from `AGENTS.md` (kept verbatim). `AGENTS.md` carries the one-line summary + a link here. Edit the invariants here; keep the `AGENTS.md` summary in sync.

**External runtime shadow administration:** Settings → Workspace → Integrations mounts
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

**Slack interaction administration:** Settings → Workspace → Integrations mounts `SlackInteractionsPanel` alongside external-runtime observers and MCP connections. It lists only the server's safe projection (name, team id, signing credential name, bounded user mappings, enabled state, and callback URL), filters the credential selector to `slack_signing_secret`, and maps Slack user ids to members returned by `/members`. It supports create/edit/delete/copy with responsive EN/ES controls and invalidates other panels through `bumpPlatformVersion()`. Recovery alert policies show the optional interaction-connection selector only for Slack channels on recovery-item triggers; all other Slack alerts remain text-only.

**Progressive workflow deployment:** the Inspector lazily mounts `WorkflowRolloutPanel` for saved workflows. The panel keeps only version/rollout orchestration on its initial boundary: `WorkflowRecoveryQualification` owns the qualification parser, read, mutation, and gate state and loads only when a baseline/candidate pair exists; `WorkflowRolloutStatus` owns the active/latest status projection and actions and loads only when that projection is visible. It reads immutable version history plus the latest deployment projection, permits an older baseline against only the newest canary, and bounds canary traffic/minimum sample/minimum success rate to the server contract. Active state shows traffic, baseline/canary terminal counts, canary success rate, and the automatic-return guardrail. Promotion and return-to-baseline use the shared accessible confirmation dialog; successful mutations call `bumpPlatformVersion()`. API payloads are parsed defensively instead of trusted through casts. Eligibility, authorization, trigger compatibility, assignment, and automatic rollback remain server-owned; the panel is not a second deployment state machine.

## Layout & canvas visibility

**Layout & canvas visibility:** the React Flow canvas (`apps/web/src/components/WorkflowCanvas.tsx`) is the most expensive component in the web bundle and only meaningful in authoring contexts. The closed-enum allowlist `CANVAS_TABS = ['copilot', 'inspector'] as const` in `apps/web/src/types.ts` is the SINGLE source of truth for which tabs SHOW the canvas in their main slot. `AppWorkspace.tsx`'s slot dispatcher consults `getCanvasVisibility(activeTab, canvasActivated)` (same file as `CANVAS_TABS`) and follows three closed states: (a) `home` → `mounted: false`, the lazy `<RecoveryCenterPanel>` owns the full slot (no canvas in the DOM at all, so users who never navigate away from home pay zero React Flow runtime cost AND zero React Flow download — both surfaces are code-split, see below); (b) canvas tab (`copilot` / `inspector`) → `mounted: true, visible: true`, the canvas wrapper is visible and `<RightPanel>` mounts in the side panel; (c) any other non-home tab renders a `<div data-layout="contextual">…</div>` with `<RightPanel>` in the full-width main slot and `panel={null}`. Before an authoring canvas has been opened in the current non-home session, `mounted: false` keeps React Flow completely out of the DOM. After activation, `mounted: true, visible: false` retains the existing wrapper hidden via `.workspace-canvas-wrapper[data-canvas-visible="false"] { display: none }`. The hidden-but-mounted posture is load-bearing: `<ReactFlowProvider>` lives inside the lazy-loaded `apps/web/src/components/CanvasWorkspace.tsx` (relocated from `main.tsx`) so `@xyflow/react` — the bundle's single heaviest dependency (~182 KB JS + 15 KB CSS) — is code-split into an on-demand chunk that stays OFF the boot/home-landing path; `AppWorkspace.tsx` renders `<CanvasWorkspace>` via `lazy()` + `<Suspense>` (reusing the `common.working` fallback) INSIDE the `workspace-canvas-wrapper`. Once a canvas tab sets `canvasActivated`, `getCanvasVisibility` keeps the wrapper mounted for later non-home tabs, so the `<ReactFlow>` instance — and thus the viewport (zoom + pan) — survives `inspector → operations → inspector` cycles in-memory (the instance is never destroyed). A round-trip THROUGH home (`mounted: false`) unmounts the canvas, but for a SAVED workflow the viewport is RESTORED on the next mount from `localStorage` (`apps/web/src/canvas-viewport.ts`, key `janusly:canvasViewport:<workflowId>`): `WorkflowCanvas` reads it as `defaultViewport` so `fitView` is skipped (`fitView={!restored}` — React Flow ignores `defaultViewport` while `fitView` is on) and persists user pan/zoom via `onMoveEnd` plus explicit React Flow `Controls` callbacks (`onZoomIn` / `onZoomOut` / `onFitView`). Only deliberate gestures are stored — the automatic fit/restore fires `onMoveEnd` with a null `event`, which is skipped; the toolbar callbacks persist Control Panel zoom/fit because React Flow reports those viewport changes with a null source event too. An UNSAVED draft has no reload-surviving identity, so it always `fitView`s (no persistence). The chunk loads only on the operator's first canvas-tab navigation; ordinary contextual destinations do not activate or download React Flow. To keep it deferred, NOTHING on the boot path may import an `@xyflow/*` VALUE: the store's React Flow change-appliers (`applyNodeChanges` / `applyEdgeChanges` / `addEdge`) are registered lazily from `CanvasWorkspace` via `registerFlowOps` (store.ts keeps only the type-only `@xyflow/react` import), `canvas-projections.ts` uses the marker string literal `'arrowclosed'` (type-only `EdgeMarker` import), and `vite.config.ts`'s `manualChunks` early-returns `undefined` for `@xyflow/` so the loose `/react/` matcher can't sweep it into the eager `react-vendor` chunk. The CSS rule `.workspace-main > [data-layout="contextual"]` (in `apps/web/src/styles/foundations.css`) centers + pads the contextual wrapper to `--we-content-max-width: 1280px`, mirroring the Recovery Center hero. Non-canvas non-home tabs gain full main-slot width without the authoring DAG sitting behind their admin/read-only content, except for the explicit run-observation companion described below. The `onNodeClick → setActiveTab('inspector')` cross-reference in `App.tsx` is safe because `'inspector'` is in `CANVAS_TABS`. Adding a new tab that needs the canvas means appending to `CANVAS_TABS` (one line); any other tab gets the contextual full-width layout and retains an already-activated canvas hidden for viewport preservation. A page reload (F5) likewise restores a saved workflow's viewport from `localStorage` (an unsaved draft is discarded by F5 anyway and re-fits). Persistence is per-browser and gated on `currentWorkflowSaved` (App passes `viewportWorkflowId={currentWorkflowSaved ? currentWorkflowId : undefined}` to `<CanvasWorkspace>`, which threads it to `WorkflowCanvas`, and keys the canvas by `currentWorkflowId` so React Flow remounts when the operator opens a different saved workflow and can re-read `defaultViewport`); cross-device sync and pruning orphan entries for deleted workflows are out of scope.


**Authoring persistence:** the shared workflow contract may carry an optional node `label` (operator-authored display identity, max 80 characters) and `ui.positions` keyed by node id. Runtime dispatch remains exclusively `node.type`; engine consumers ignore `ui`. Positions retain React Flow's established top-left origin so historical fallback coordinates keep their visual meaning. `graphToWorkflow` persists every finite React Flow position, while `workflowToGraph` restores positions per node and uses the deterministic diagonal fallback only when a historical node has no persisted coordinate. A completed drag marks `workflowDirty` so versioned save and local draft autosave capture layout, but it deliberately does NOT increment the semantic `workflowRevision` used to invalidate readiness and AI findings. Palette placement stays inside the lazy canvas: `WorkflowCanvas` registers a viewport-centre resolver through `registerNodePlacementResolver` and estimates the rendered node footprint from an existing sibling before resolving the top-left coordinate; the boot-reachable store must never import a React Flow value. The empty-selection Inspector owns direct top-level object input/output authoring; its `WorkflowIoEditor` is locally lazy-loaded so this secondary form does not grow the boot entry, and a non-object root schema is preserved read-only rather than flattened destructively.

**Guided authoring interactions:** Workflows → Build is the one visible authoring section. Historical `copilot` routes remain restorable as a hidden mode and keep Build highlighted, but they do not compete in the contextual rail. Creating a workflow offers three explicit starts: describe it with AI, start from the blank starter graph, or open Templates. A newly created draft defaults to Build; only the describe path opens the AI mode. `CanvasStepPicker` is the SINGLE node-discovery surface for every registered node type: it groups and searches the closed catalog, supports click-to-add and drag-to-place, and closes after either action so its overlay cannot retain pointer ownership over the canvas. Drag payloads contain ONLY the node type; `WorkflowCanvas` validates that value against `nodeTypes`, accepts drops only on the React Flow interaction surface (never the picker, summary toolbar, controls, or MiniMap), lets the empty-canvas teaching card pass first-use drops through, converts the pointer to a top-left flow coordinate with the same rendered-footprint resolver used for centered insertion, and lets the store apply the canonical preset. Adding a node selects it immediately so Build opens its Step scope without another click. The `readOnly` boundary is enforced by the canvas, not just its side panel: users without `workflows.write` cannot add, drag, connect, reconnect, or delete nodes or edges. Node duplication is store-owned, copies durable node data/config only (never React Flow measurement or selection fields), offsets the copy, selects it, and intentionally does not copy edges. The interactive React Flow MiniMap appears only on authoring graphs with at least six nodes; observation graphs remain immutable and never render it. `AuthoringPanel` is the shared Build rail and owns Step, Workflow, and Problems scopes: selecting a node or edge activates Step, deselection activates Workflow, and Problems combines deterministic validation, readiness, and AI review findings. Its contextual Generate, Explain, Review, and Fix actions open the hidden AI mode; generating a draft keeps that mode mounted so candidate evidence and fallback details remain visible until the operator selects a node or returns to Build, while Fix proposes a bounded improvement and requires an explicit Apply to draft action. The Inspector's subworkflow input uses an editable `datalist` backed by the already-loaded, tenant-scoped active workflow page: it excludes the current workflow from suggestions, marks an already-configured direct self-reference invalid, and keeps manual entry plus clearing available because the loaded page is bounded and cannot be treated as the complete tenant catalog. Its adjacent optional version field accepts only integers in the persisted PostgreSQL range, explains exact-pin versus latest-at-run-time behavior, and removes the old pin whenever the operator changes the child workflow id so a version number cannot silently cross child identities. The starter graph is an executable HTTP → condition → approval example: the condition reads the HTTP executor's `statusCode`, and the approval edge runs only when the condition output is true. Global Help opens the shared shortcut dialog; Cmd/Ctrl+1–4 switch to Home, Workflows, Activity, and Settings, respectively. These interactions must stay inside the existing lazy canvas boundary and may not add a browser-side workflow or cron parser dependency.

The HTTP Inspector is basics-first and mirrors the existing engine contract rather than inventing a web-only request model. Method and URL are always visible; methods that can carry a payload expose an optional arbitrary-JSON body. Headers plus buffered/stream response handling live behind one request-options disclosure, while retry, timeout, and response bounds live behind a separate Resilience disclosure. Existing configured options are summarized while collapsed, malformed optional JSON remains local until it parses, switching back to buffered mode removes stream-only keys, and readiness deep links open and focus the collapsed Resilience controls through the existing focus bus. `HttpConfigEditor` owns the request surface, `ResilienceFieldset` owns operational policy, and `QuickConfigEditor` remains only the node-type dispatcher; Advanced JSON stays the escape hatch for forward-compatible passthrough keys.

The AI Inspector follows the same basics-first boundary through `AiConfigEditor`.
Prompt source is an explicit, mutually exclusive choice between inline text and
an organization-scoped saved prompt; each transition removes the inactive
source so the editor cannot create the runtime's ambiguous
`prompt` + `promptRef` state. The saved-prompt list is parsed as untrusted
server data, loaded only when that source is selected, trimmed, deduplicated,
and capped at 200 entries. Output is one of
plain text, JSON text, or validated structured data; changing modes removes
stale `responseFormat` / `outputSchema` keys, and structured mode starts from a
valid minimal contract. Prompt version, variables, and the Anthropic model
override stay behind one Advanced disclosure. Canvas and Inspector summaries
use the same `promptRef`-first precedence as the executor, while workflow
validation accepts either a nonblank inline prompt or a valid saved-prompt
reference. Advanced JSON remains the forward-compatible escape hatch.

The registered-tool Inspector follows the same boundary through
`ToolConfigEditor` and the shared `ToolPicker`. Search filters the bounded
server catalog by stable name or localized purpose without hiding the current
selection. The public catalog's required `writeSide` capability bit labels a
tool as read-only or potentially effectful before execution; runtime
input-sensitive classification remains authoritative. Selecting a different
tool replaces the previous `input` with the selected contract's bounded
`inputExample` or `{}`, so stale fields cannot silently cross tool schemas.
The same Zod object schema produces a bounded `inputFields` projection
(`string` / `number` / `integer` / `boolean` / `json`, required, string enum)
without exposing the planner-only JSON Schema. `ToolInputFields` renders those
descriptors as the primary form, preserves complete runtime template
expressions across every kind, keeps unknown keys untouched, and leaves the
exact input object behind Advanced JSON. Invalid drafts stay local until
corrected; runtime validation remains authoritative. The field editor is lazy
loaded only after a registered tool is selected so its schema-form machinery
does not expand the initial workflow workspace. The resilience disclosure
remains available even before a tool is selected. `ToolPicker` and the
`ToolInputEditor` dispatch boundary are both reused by
`loop.mode="for_each"`; do not fork another tool catalog, field parser, or
search model.

**Branch-rule authoring:** condition nodes and conditional edges share
`BranchRuleEditor`. The primary path projects one safe path-versus-literal
comparison into aligned source/operator/value controls, inferring scalar type
from the declared input, upstream output, or existing expression. It uses only
scalar graph inputs and upstream outputs reachable at that execution point.
The selector shows the exact durable context path so the saved rule remains
inspectable without a hidden display-name mapping.
An unconditional edge stays an absent condition; an always-true condition node
stays the literal `true`. Compound boolean expressions, list membership, loose
equality, and any expression outside the lossless guided subset open in the
advanced exact-text editor and are never rewritten merely by rendering.
The subset parser/formatter lives beside the runtime evaluator in
`@janusly/shared/src/expression`; contextual reachability and validation status
remain shared through `expression-context.ts`, with errors rendered by the
editor beside the affected control. Do not fork separate node/edge editors or
a browser-only expression grammar.

**Declared run input UX:** workflows with a typed `inputs` schema open the lazy `RunInputDialog` before `POST /start`; workflows without inputs keep the one-click run path. Durable schema keys remain unchanged in the submitted payload, while `run-input-model.ts` derives readable labels, maps JSONPath server errors, and owns state parsing independently from the dialog view. Required fields render before optional fields and each group uses a stable readable-label order because PostgreSQL JSONB does not preserve authoring order. Every field shows an explicit Required/Optional badge; a boolean has an unset/Yes/No state so untouched required values cannot silently become `false`, while explicit `false` remains valid. The first rendered field receives focus through the shared dialog-focus primitive, keyboard trapping/restoration stays centralized, and the engine remains the authoritative default/type validator.

**Human-form authoring:** `human_form` quick setup reuses the same lazy
`SchemaFieldsEditor` and `WorkflowInputSchemaShape` model as declared workflow
inputs. The guided path owns flat string, number, and boolean fields plus their
names, descriptions, and required posture; form fields never expose workflow
input defaults. Nested objects, arrays, malformed roots, and forward-compatible
schema shapes are preserved exactly and remain editable through the node's
existing Advanced JSON surface rather than being flattened into a second
browser contract. Removing the final field keeps an empty object schema so the
canonical workflow validator can report the incomplete form. The Inspector and
quick setup share one dynamic-module loader; do not fork another form-schema
editor or eagerly move this secondary authoring surface onto the workflow
workspace path.

**Loop authoring:** the Inspector preserves omitted/default `map` behavior and exposes `for_each` as an explicit mode with the existing registered-tool picker, the shared schema-guided per-item input form plus Advanced JSON, concurrency 1..20, and one count-or-percentage failure budget. Switching budget units removes the inactive key, fractional percentages remain exact, and legacy mapping stays in config when the operator temporarily selects tool execution. EN/ES labels and browser coverage live in the same lazy authoring boundary; do not duplicate the tool catalog or create a web-only validation model.

**Run observation exception:** Activity and Reasoning remain NON-authoring tabs and MUST NOT be added to `CANVAS_TABS`. When Activity has a selected run with a valid `runs.input_json.workflow` snapshot, its contextual slot switches to `data-layout="run-observation"`: a separate `RunObservationWorkspace` React Flow provider renders that exact snapshot beside the Activity panel. Selecting a recovery clears the stale active-run projection before rendering the recovery detail, so a prior run map can never appear beside an unrelated case. `getRunWorkflowSnapshot` and `workflowToGraph` in `canvas-projections.ts` validate historical JSON fail-closed, restore persisted positions when present, and use the established deterministic layout as the per-node fallback; `projectVisibleNodes` overlays only the active run's `run_nodes` statuses. The selected detail snapshot is retained independently from the bounded `/runs` page, so refreshes and newly started runs cannot make the map disappear. Async run ownership binds both the active run id and a monotonic `runTransitionGeneration`; identity, workflow, active-run, and recovery-selection transitions increment that generation atomically with projection cleanup. Open/start guards and status/history requests capture it before awaiting, then fail closed if either owner changes; discarded polling responses also skip connection and terminal lifecycle effects. `WorkflowCanvas mode="observe"` disables drag/connect/reconnect/delete, hides handles, keeps pan/zoom/focus, labels nodes with localized status for assistive technology, pulses `running` nodes, and replaces that motion with a static ring under `prefers-reduced-motion`. This is deliberately a SECOND provider/instance: the hidden authoring canvas stays mounted and untouched, so observing a run can never mutate the draft, select an editor node, or replace the saved authoring viewport. Activity/Reasoning without a valid selected snapshot keep the normal full-width contextual layout. At ≤1200px the observation map stacks above the panel; wider desktop windows keep both side-by-side.

**Activity workspace:** Activity mounts `ActivityWorkspace`, whose first surface is one chronological read model built from the bounded App-owned `/runs` and `/dlq` bootstrap projections. It MUST NOT add a competing feed fetch or reuse `useRecoveryQueueFilters` as a second selection authority. The bounded `/runs` projection includes `hasWaitingNodes`, because a durable run remains `running` while an approval or form node is waiting; Activity uses that read-model signal for Needs action without rewriting lifecycle state. App owns the selected recovery id while the existing run store owns the selected run id, so switching between the contextual and run-observation layouts cannot erase selection when React remounts the panel. The five primary filters are All, Running, Needs action, Failed, and Recovered; normal successful runs remain visible under All and are not mislabeled as recovered. Run and recovery rows keep workflow identity, step identity where applicable, status, timestamp, and one explicit next action. Selecting a row preserves the inventory and opens contextual detail: a run reuses `RunWorkspace`/`RunsPanel` in `activity-detail` mode, while a recovery loads the unbounded `/dlq?id=` evidence only for the selected row and reuses the established Recovery dialog, Replay Lab, export, replay, and resolution gates. Ask Janusly mounts only inside selected run/recovery detail. `RunWorkspace` still composes Overview, Timeline, and Agents behind accessible tabs, consumes the active run data already owned by `App`, and resets to Overview when run identity changes. Detailed run history and the complete recovery console remain explicit advanced tools. Historical Recover, Reasoning, and Agent routes stay restorable as hidden Activity aliases for persisted state, expert actions, and the command palette; they do not compete in the contextual rail.

**Task-space navigation:** the persistent sidebar exposes exactly four stable
destinations: Home, Workflows, Activity, and Settings. The typed registry in
`apps/web/src/workspace-locations.ts` is the single map from each internal
`ActiveTab` to its destination and contextual section. Workflows contains All
workflows, Build, Templates, and Experiments; Templates unifies recipes and
solution packs behind one search. Activity has one visible chronological
workspace for runs and recoveries; its historical Recover, Reasoning, and Agent
routes are hidden expert aliases. Settings contains Workspace, Connections,
Team, and Tools. Workspace opens on a searchable inventory of six focused
areas—Reliability, Integrations, Access, AI, Usage, and Infrastructure—and
shows current status before configuration forms. The index and contextual rail
share `settings-sections.ts` as the one OR-capability visibility policy for
areas containing multiple independently authorized panels, while every child
still owns its exact read/write gates. Persisted or requested sections are
permission-resolved before any child mounts. Page-level reads follow the same
boundary: recovery metrics are not requested without `recovery.read`, and the
admin queue projection is not requested without `org.config.write`.
Connections opens on a bounded searchable inventory with type, safe owner
metadata, declared expiry, last-use posture, and health. Creation and rotation
live in focused dialogs; secret values remain write-only and mutation controls
remain absent for readers. Long connection inventories use `useVirtualList`
rather than mounting every row.
Permission filtering is delegated to the existing `canOpenTab` policy and
opening a destination selects its first permitted section. Home has no
redundant section rail. The command palette keeps direct expert routes while
putting the four destinations first.

The authenticated user popover is a non-modal labelled `dialog`, not an ARIA
`menu`: it contains workspace switching, radios, a locale select, profile
fields, actions, and links that are invalid direct children of `role="menu"`.
Its trigger therefore advertises `aria-haspopup="dialog"`; keep Escape,
outside-click dismissal, and trigger focus restoration without claiming modal
focus containment.

The Build header keeps three status domains explicit instead of presenting
apparently contradictory generic pills: Production is deterministic draft
readiness, Workflow is the saved runtime-health rollup, and Recovery is the
organization recovery queue. The Production summary opens the canonical
Problems scope; it must not grow a second issue popover, expose raw readiness
codes, or duplicate the Problems panel's localization and deep-link logic.

Internal `ActiveTab` values remain the persistence and panel-routing contract,
so historical `janusly:activeTab` values restore into the correct destination
without migration or deep-link breakage. Sidebar persistence now owns only
collapsed state; obsolete group keys are ignored. The workflow identity card,
compact Validate/Save/Run actions, and AI status strip render only for the two
authoring tabs (`copilot` and `inspector`); operational destinations never
carry unrelated draft controls. Node discovery belongs only to the canvas
picker. Workflows keeps a visible New workflow action that opens the
three-choice start surface and remains disabled when `workflows.write` is
absent. Activity owns execution inventory, active-run evidence, waiting human
actions, explanations, recovery evidence, and permission-gated replay/resolve
actions. Detailed run history and the full dead-letter console remain
progressive-disclosure tools. All projections consume the same App-owned run
and dead-letter state; the hidden Recover route is not a second polling or
run-authority path.

## Web deps

**Web deps:** runtime dependencies are intentionally narrow: `react`,
`react-dom`, `@xyflow/react`, `@supabase/auth-js`, `zustand`, `lucide-react`,
and focused zero-dependency `@janusly/shared/src/*` subpaths. The browser uses
Supabase only for GoTrue authentication, so the broader `@supabase/supabase-js`
client is not allowed. `status`, `workflow-diff`, `expression`,
`recovery-autonomy`, `technical-recovery-autonomy`, and `recovery-passport` are
canonical runtime grammars or pure projections shared with the server; never
fork web-only evaluators for them. Do not import the broad `@janusly/shared`
barrel from web because it pulls workflow Zod schemas into the browser bundle.
No `@radix-ui`, `class-variance-authority`, `clsx`, or `tailwind-merge`; the
design system is hand-written CSS. Do not reintroduce shadcn-style scaffolding.

**CSS architecture:** `index.css` imports Tailwind's theme and preflight layers,
then `foundations.css`, `control-plane.css`, `navigation.css`, `workflow.css`,
`platform.css`, and `accessibility.css` in that exact order. Navigation,
account, feedback, and Home styles remain eager because those surfaces render
before any canvas; `canvas.css` is the only route CSS module and is imported by
`CanvasWorkspace.tsx` so non-authoring sessions do not transfer React Flow
chrome. Do not import Tailwind's utilities layer unless production JSX adopts
utility classes deliberately. `foundations.css` owns `@theme`, runtime aliases,
and `--we-radius-pill`. Runtime cards use `.we-card`; pills use `.we-pill` plus the
closed `data-tone="info|warning|neutral|ghost|primary|danger|success"`
vocabulary. `scripts/check-css-classes.mjs` scans every CSS module plus
production TypeScript literals and fails `pnpm lint` on any unowned selector;
React Flow's external class namespace is the only prefix exemption. Primary
navigation, actionable copy, explanatory copy, and workflow content have a
12px minimum; compact status badges may remain smaller when they are not the
only carrier of meaning. Playwright verifies the primary-text floor on Home and
the authoring journey.

**i18n dependency posture:** application code imports only Janusly's
`apps/web/src/i18n/` chokepoint. The focused runtime uses React's
`useSyncExternalStore` and local compact catalogs; neither `i18next` nor
`react-i18next` is a dependency. Consumers use `useT()` / `t()` and the typed
server-event helpers described below.

**Workspace decomposition (structure of record):** `App.tsx` coordinates
application data and hands a render model to `AppWorkspace.tsx`; the render
shell owns lazy workspace boundaries, ErrorBoundaries, layout slots, and
overlays. `useAppStore` centralizes the scoped Zustand projection,
`useIdentityBootstrap` owns provider and tenant synchronization, and the
`useAppCommands` facade composes focused workflow, run/recovery, and integration
command hooks. Existing
`useBootstrapData`, `useRunPolling`, `useRunEventStream`,
`useKeyboardShortcuts`, and `useDraftPersistence` retain their focused effects.
The workflow inventory is a controller (`WorkflowsDashboard.tsx`), a render-only
view (`WorkflowsDashboardView.tsx`), and pure folder-state transitions
(`workflows-dashboard-model.ts`). Home recovery follows the same
`RecoveryCenterPanel.tsx` controller plus `RecoveryCenterView.tsx` boundary.
Keep workspace containers below 700 lines and test controller/data behavior
without depending on the full shell. `RecoveryDialog.tsx` remains split into
prop-driven bodies plus the pure `recovery-dialog-model.ts` under
`components/recovery-dialog/`; the parent keeps the state machine, focus/ESC
and validation-poll effects, and explicit validate-then-apply callbacks. Mirror
these focused controller/view/model boundaries; do not re-inline them into a
single route component.

The Reasoning tab and the Runs workspace's Timeline projection share the lazy `ReasoningPanel` chunk rather than placing it on the eager `App` path. Its `constants` and `useVirtualList` dependencies are shared chunks because Runs history also consumes them; keep the three reviewed names in `apps/web/performance-budgets.json`. Do not move the long-run timeline back into `RightPanel.tsx` or `RunWorkspace.tsx`: the feature-specific filtering, focus navigation, payload rendering, and fixed-row virtualization belong in the sibling component, while the wrappers remain lazy dispatchers.

`OperationsPage` is the lazy internal route shell for Settings → Workspace and
each heavy child card is also a lazy import. Only the active overview or one of
Reliability, Integrations, Access, AI, Usage, and Infrastructure mounts its
content, so inactive code and fetch effects remain off the navigation path.
Keep the shell's health summary and section router eager within that route, and
place feature-specific state and effects in the corresponding child panel.
`ConnectionsPanel` is a separate lazy route chunk so its inventory and dialogs
do not grow the initial Settings workspace payload.

The zero-dependency `@janusly/shared/src/api-contract` subpath is also allowed:
it is the canonical exact-path catalog for reads transported over `/v1` and
prevents the browser from maintaining a second list beside OpenAPI. Do not
replace it with a broad `@janusly/shared` barrel import.

## Startup loading boundaries

The production entry may contain boot infrastructure, but not eager locale
values or the Supabase implementation. `main.tsx` starts the selected locale
and `App` imports concurrently, then mounts React only after the core namespace
is registered. The compact-catalog plugin front-codes the canonical English
key order into the locale-neutral `catalog-keys` projection and emits only
translated values in each locale module. The registry owns
`materializeCatalog()` and keeps the shared key projection on the eager
application path; this prevents the bundler from assigning shared keys to one
language chunk and making another language download it. Runtime namespaces
remain separate: core boots the shell, and `I18nNamespaceGate` registers
workspace strings only when a workspace surface needs them. Production
`manualChunks` deliberately coalesces each language's two value modules into
one physical `catalog-en` or `catalog-es` chunk so gzip gets one language-wide
dictionary and navigation does not pay extra wrapper requests; loading bytes
is not the same as registering the workspace namespace. `materializeCatalog()`
expands and validates the NUL-delimited front-coded keys and rejects length
mismatches before reconstructing a fragment. The selected locale is the only
locale fetched at boot, and `changeAppLanguage()` fetches the other language
before persisting the preference.

The dependency-free runtime supports Janusly's bounded catalog features:
cardinal plurals, interpolation, safe rich-text component slots, missing-key
defaults, and synchronous React subscriptions. The compact plugin is registered
in Vite and Vitest Browser because both graphs import the projected modules.
Supabase authentication is reached only through lazy `supabase-runtime.ts` and
`@supabase/auth-js`; dev headers and SSO stay on the lightweight path.

Production chunks follow operator workspaces rather than source-file accidents:
`app-workspace` combines App, identity/command hooks, and Home recovery;
`workflow-workspace` combines workflow inventory and authoring panels; React
Flow plus `canvas.css` stays behind `CanvasWorkspace`. Bundle governance keeps
two different envelopes instead of presenting the sum of mutually exclusive
locale catalogs as a normal-session transfer: the complete production JS/CSS
artifact is <=580 KiB gzip, while the worst single-locale JS/CSS set is <=530
KiB gzip (all non-locale assets plus the larger locale catalog). The cold Home
remains <=250 KiB transferred; opening the workflow builder, selected recovery,
or Recovery Tools remains <=90 KiB; the secondary Recovery automation
disclosure is <=20 KiB; and an explicit locale switch is <=55 KiB. Entry
JavaScript remains <=2 KiB gzip. `routes.performance.spec.ts` proves English
and Spanish cold starts, selected-locale-only loading, explicit locale
switching, Supabase-deferred, React-Flow-deferred, disclosure-level route
transfer, and long-task contracts. `bundle-report.mjs` fails closed when either
locale asset is absent. Do not raise a cap without measured evidence and a
reviewed exception.

## Render-error blast radius

`ErrorBoundary` (`apps/web/src/components/ErrorBoundary.tsx`) is the single
render-error boundary: a class component, because `getDerivedStateFromError`
has no hook equivalent. It wraps three surfaces — the React Flow canvas
(`WorkflowCanvas.tsx`), every tab panel (the one `RightPanel` mount point, so a
new tab is covered without extra wiring), and the Recovery Center home surface
(`AppWorkspace.tsx`, which renders outside the panel router).

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

**i18n:** `apps/web/src/i18n/` is the single translation chokepoint. The web
ships `en`, `es`, and a `system` preference resolved once at boot through
`navigator.languages`; persistence uses `localStorage["janusly:locale"]` behind
defensive access. `main.tsx` awaits `bootstrapI18n()` for the resolved core
fragment before `createRoot`, with no Suspense and no remote backend. Canonical
flat JSON lives at `i18n/locales/<lng>/common.json`; `_one` / `_other` suffixes,
`{{value}}` interpolation, and explicit rich component slots are interpreted by
the local runtime. Build-time core/workspace projections are generated
artifacts, never a second editable catalog.

Application code receives the bounded `Translate` signature `(key: string,
options?) => string`. React consumers call `useT()`, which subscribes through
`useSyncExternalStore`; non-React helpers use the stable `t` from `runtime.ts`.
`Trans` parses only trusted catalog tags and clones explicitly supplied React
components; malformed or unknown tags degrade to text and no HTML is injected.
Catalog parity and compact-catalog tests enforce completeness, separator safety,
and materialization integrity. Server strings go through
`tValidationIssue`, `tReadinessIssue`, `tAiReviewIssue`, `tRunEvent`,
`tFailureCluster`, `tApiError`, and related helpers, falling back to the server's
English message for unknown codes. API error envelopes remain `{ error, code,
params? }`; adding a code requires the closed server union plus matching EN/ES
`apiErrors.<code>` keys. Date and number formatting always receives
`getResolvedLocale()` explicitly. Adding a locale requires its canonical JSON,
core/workspace projected modules, loader-map entries, and a reviewed production
chunk mapping. Free-form provider errors remain visible through the bounded
fallback rather than being silently discarded.

## Home

**Home:** the authenticated landing page is `activeTab: "home"` (set in `apps/web/src/store.ts`), rendering the lazy `RecoveryCenterPanel` controller and `RecoveryCenterView` render boundary inside its own `ErrorBoundary` and `Suspense` fallback. Home is an action workspace, not a second operational dashboard: its first viewport contains one concise combined-health summary, at most three deterministic priority actions, and at most three recent active runs. `HomeActionWorkspace` owns that bounded presentation while the pure projections in `apps/web/src/components/recovery-center/recovery-center-model.ts` own ordering, deduplication, and canonical open-run classification. Healthy organizations return no synthetic recommendation; they receive a calm caught-up state with Activity as the optional next destination. Server-driven `OnboardingBanner` remains the only setup guide and exposes only the next incomplete outcome. Operational rows remain authoritative in Activity or the exact case/run workspace rather than being duplicated as Home queue, approval, or semantic-case tiles.

Priority order is pending approvals → open semantic cases → clustered recover-all or individual triage → elevated recovery risk, capped at three after the mutually exclusive cluster/triage choice. Each action deep-links to the narrowest available context: the exact waiting run, semantic case, or dead-letter record; only aggregate cluster/risk guidance opens Settings. Active work uses the canonical run-status guard and opens the selected run in Activity. Heatmaps, clusters, qualification, cost, calibration, validation, historical trends, and Recovery Lab live in the lazy `HomeInsights` disclosure below the action workspace. `VitalSignsStrip` remains the shared metric primitive inside that secondary disclosure; Home must not restore a bespoke above-fold metric grid. The store's `newWorkflow()` reset intentionally routes to `"inspector"` so a fresh draft opens Build, while the explicit describe-with-AI path routes to `"copilot"`; do not make the generic reset AI-first again.

Home's primary server read remains the coalesced `GET /recovery/home`, whose independently degradable section envelopes contain metrics, semantic cases, clusters, heatmap, validation, lifetime ledger, personal wins, and the authoritative queue overview; run nodes still come from the App-owned store. The server reuses the same focused read models, so Home cannot drift into a second metrics or clustering implementation. A failed section returns `status: "unavailable"` without erasing successful siblings. The browser parses the outer envelope defensively, preserves known semantic cases through refresh failure, and marks combined health unavailable whenever metrics or semantic posture cannot be confirmed; the inline Retry refreshes the platform snapshot. The global recovery posture unions open-quarantine run ids with waiting runs from the bounded bootstrap projection plus the selected-run node fallback, so independent projection timing can never claim everything is caught up while containment is visible.

Every browser snapshot carries the organization and, for personal wins, the user that produced it; a tenant or identity switch neither renders nor accepts an earlier owner’s result and collapses the Insights disclosure. `platformVersion` and terminal run-stream events invalidate the full snapshot immediately. A visibility-aware `GET /recovery/home?scope=impact` fallback refreshes only ledger, personal wins, and queue every 10 seconds while failures remain open, every 60 seconds while healthy, never while the document is hidden, and once on foreground. This keeps missed-event and Redis-degradation recovery without repeatedly executing the heavier projections. Isolated insight tiles may own distinct read-only endpoint fetches when their data is not part of the Home envelope — `BudgetTile` uses `/billing/budget` and `CalibrationHealthTile` uses `/recovery/calibration-status`, both refetching on `platformVersion` and rendering a non-blocking local error state. Responsive breakpoints at 1100/760/480 reflow priority and active-work columns into one column, and the 480px contract keeps action targets at least 44px high.

The semantic priority action opens the lazy contextual `RecoveryCasePanel`,
which fetches the stable tenant-scoped detail contract and shows the finding,
bounded evidence, chronological transition receipts, run deep link, and
effective autonomy Recovery Passport. The policy card renders the Level 0–4
capability ladder from the server profile rather than deriving authority in the
browser; replacement controls appear only when `applyWithApproval` is enabled,
while accepted loss remains available for an explicit closure. The contextual
case id is not included in `PERSISTED_TABS`; refreshing or changing identity
returns to a safe top-level workspace rather than restoring a case without
authority or context. The panel parser rejects malformed case or receipt
envelopes in full, date formatting follows live locale changes, and read-only
users retain the evidence view without mutation controls.

Recovery time copy delegates to `formatDuration` in `recovery-center/recovery-center-model.ts`; the legacy `formatDowntime` export is only a compatibility wrapper, and relative ages use the same core with runtime locale keys. Home Insights routes recovery-time selection through `selectRecoveryTimeMetric`: prefer the versioned production-only `verifiedRecovery` median and use legacy average `mttr` only when an older API omits the new field. The selectable trend is a per-day median over the same eligible production impact events. Sparkline points and selectable heatmap cells are composite keyboard controls with one roving tab stop: arrows plus Home/End move focus, and Enter/Space/click publishes the existing recovery-day handoff before opening Activity. Keep the sparkline point targets as siblings of the metric's main button (never nest interactive SVG controls in a button), keep empty heatmap days non-actionable, and keep unlabeled sparklines decorative. The truly-fresh Recovery Lab entry waits for a successful metrics section before exposing dismissal; its dismissal lives in the Zustand session state and resets when the auth owner or organization changes. It presents no fabricated incident, transcript, score, timing, or cluster evidence. The operator must explicitly start a controlled solution-pack drill, whose run is tagged as validation data and excluded from production rollups, before Janusly creates any recovery activity. Do not persist dismissal to `janusly:recovery:hideIntro` until the Home metrics section reports real terminal history, so a fresh-workspace reload restores the truthful lab entry.

**Replay-campaign UI:** `DeadLettersPanel` exposes paced campaign creation only from multi-select, with the server preview shown before the operator can submit. `ReplayCampaignDialog` uses the shared modal focus contract and never derives cohort eligibility in the browser. `ReplayCampaignsCard` renders the eight newest durable campaigns, polls every three seconds only while at least one is running, refreshes on `platformVersion`, and requires inline confirmation before cancellation. Progress is the server's settled counter (`replayed + failed + cancelled`) over the immutable total; it must not infer success from queue acceptance. The surface stays bilingual and usable at 390px without hiding the stop control. An empty campaign list renders no placeholder card so ordinary recovery triage does not gain permanent visual weight.

## Inspectable AI guidance and decisions

Operator AI policy has two bounded bilingual editors. `AiGuidanceSettingsPanel` lives in Settings → Workspace → AI and reads/writes the closed `ai.operatorGuidance` organization setting through the existing `/org/config` routes. `WorkflowMetadataPanel` owns the optional per-workflow `aiGuidanceMarkdown` field through the existing whole-row metadata route. Both show a UTF-8 byte counter, explain that the field is preferences rather than a secret store or policy override, prevent an over-cap save, and call `bumpPlatformVersion()` after success. Do not introduce a second settings endpoint or persist the text in browser storage; the tenant-scoped server writers and their audit-safe descriptors are authoritative.

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
unavailable state and never infer consent. Settings → Workspace → Access mounts the
read-only `MemoryGovernancePanel`, showing the process gate, tenant gate, and
the safe purge projection (`none` / `scheduled` / `running` / `unknown`). When
tenant consent is off and deletion is scheduled, Recovery Center shows a
whole-minute countdown and deep-links to that panel; re-granted consent hides
the warning even if a best-effort cancellation left a job visible, because the
worker re-checks consent before deleting. `AuditLogPanel` owns the `memory.`
quick filter and a scroll-safe wrapped table for the resulting grant/revoke and
purge actions. Keep all three surfaces bilingual and org-bound; the hook must
not render a previous tenant's snapshot while a new request is pending.
