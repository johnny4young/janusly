# design-sync notes — Janusly

Repo-specific gotchas for syncing `web/` to claude.ai/design. Read this before
re-running the sync; it is the accumulated cost of the first import.

## Shape and why

- **No Storybook, no library build.** `web/` is the Janusly application, not a
  published component package: `package.json` has no `main`/`module`/`exports`
  and there is no `dist/` of components. The converter therefore runs in
  **synth-entry mode** — it walks `src/` and synthesizes an entry that
  `export *`s every component file. Expect the `[NO_DIST]` line on every build;
  it is the normal path here, not a failure.
- Because discovery is source-based, multi-export files contribute several
  components each (`panel-primitives.tsx` → `PanelChrome` / `EmptyView` /
  `PanelSearch`; `quick-config-fields.tsx` → the `*ConfigField` family;
  `RecoveryCenterTiles.tsx` → the `*Tile` family). 147 component files yield
  **168 components** after the `componentSrcMap` exclusions — the gap is
  expected, not over-inclusion.

## Setup steps that are NOT in the config (redo these on a fresh clone)

1. **Package self-reference — as a directory of symlinks, never one symlink.**
   npm will not self-install, so `@janusly/web` does not resolve from inside
   `web/`. Without it the build dies in `dts.mjs → projectFor` on a missing
   `node_modules/@janusly/web/package.json`. It also has to resolve for the
   authored previews, which import from `'@janusly/web'`.

   **Do NOT do the obvious thing** (`ln -sfn ../.. node_modules/@janusly/web`).
   That points the package at `web/`, which *contains* `node_modules`, so the
   path `node_modules/@janusly/web/node_modules/@janusly/web/…` recurses
   without end. It survives a few builds and then kills one with
   `ENAMETOOLONG: scandir` mid-run, leaving a **partially written
   `ds-bundle/`** (no `_ds_bundle.js`, no `.ds-build-meta.json`) and taking
   `dist/types` with it — so the next `package-capture.mjs` fails with the
   misleading "run package-build.mjs first".

   Link the individual entries instead, so the package dir has no
   `node_modules` child:

   ```sh
   mkdir -p node_modules/@janusly/web
   for e in package.json tsconfig.json tsconfig.app.json index.d.ts src dist types .design-sync; do
     ln -sfn "../../../$e" "node_modules/@janusly/web/$e"
   done
   ```

   Those are exactly what the converter reads through `PKG_DIR`:
   `package.json` (name/version), `src/` (component discovery), `types/`
   (`findTypesRoot`), `index.d.ts` (the prop-extractor entry), `.design-sync/`
   (`extraFonts`, `extraEntries`), `dist/` (unused by the converter but kept so
   the tree matches the repo), and the tsconfigs (path aliases). `cssEntry` is
   NOT read through the symlink — see step 3. Gitignored by the repo's existing `node_modules` rule — recreate
   it per clone. After recreating it, verify:
   `ls node_modules/@janusly/web/node_modules` must fail.

2. **`src/main.tsx` must stay out of the synthesized entry.**
   `.design-sync/overrides/source-kit.mjs` is a fork of the converter's package
   adapter that filters application entry modules (`main.*`, `index.*`) out of
   the synth entry. It is declared in `cfg.libOverrides`. Do not drop it —
   without it two things break at once, both silently:

   - **Typography.** `main.tsx` imports `src/index.css`, which `@import`s
     `tailwindcss/theme.css` and `tailwindcss/preflight.css`. Those are Tailwind
     v4 *source* files: they use the compile-time `--theme()` function, which
     only the Tailwind compiler can evaluate. esbuild inlines them verbatim, so
     `_ds_bundle.css` ended up carrying
     `font-family: --theme(--default-font-family, …)` — an invalid declaration
     the browser drops. Nothing then set a font on `html`, and **every preview
     card rendered in the browser default serif (Times)** while the 46 shipped
     `@font-face` rules sat unused. Nothing flags this: the render check only
     asks whether the root is non-empty. It was caught by inspecting a live card
     (`getComputedStyle(document.body).fontFamily === "Times"`).
   - **Runtime.** `main.tsx` has top-level side effects — `bootTheme()`,
     `bootstrapI18n()`, and `createRoot(...).render(<App/>)`. Bundled, they run
     on every card load.

   Quickest regression check after any converter upgrade:
   `grep -c -- '--theme(' ds-bundle/_ds_bundle.css` must be **0**.

3. **Generate `compiled.css`.** `cfg.cssEntry` names `ds-compiled.css` (a copy
   inside the package dir, see below); the source is
   `.design-sync/compiled.css`, which is **generated, gitignored, and not
   produced by the converter**. It is the concatenation of the two production
   stylesheets Vite emits (the second is the demand-loaded React Flow sheet
   that `WorkflowStepNode` / `WorkflowEdge` / `CanvasWorkspace` need):

   ```sh
   pnpm build && cat dist/assets/index-*.css dist/assets/CanvasWorkspace-*.css > .design-sync/compiled.css
   ```

   That is `cfg.buildCmd` verbatim. Do not point `cssEntry` at `src/index.css`:
   it `@import`s `tailwindcss/theme.css` and `tailwindcss/preflight.css`, which
   only resolve through the `@tailwindcss/vite` plugin. The filenames are
   content-hashed, hence the glob.

   **Why `buildCmd` copies it to `node_modules/@janusly/web/ds-compiled.css`,
   and why `cfg.cssEntry` names that copy.** Of all the `cfg.*` path fields,
   `cssEntry` is the one bounded to `PKG_DIR` itself (the others are bounded to
   the git repo) — the converter resolves it, calls `realpathSync`, and rejects
   anything landing outside. `.design-sync/` inside the package dir is a
   symlink back to `web/.design-sync/`, so a `cssEntry` of
   `.design-sync/compiled.css` real-paths *outside* `PKG_DIR` and is dropped.
   The failure is nearly silent — one `! cssEntry: … ` line in the build log —
   and the result is a `_ds_bundle.css` of ~22 KB (just the canvas styles that
   rode in through the JS graph) with **no design tokens at all**. Check
   `wc -c ds-bundle/_ds_bundle.css`: it should be ~330 KB, not ~22 KB.

## The `.d.ts` contract — two generated artifacts the converter cannot make itself

This was the single biggest quality problem of the first import, and it is
**silent**: `package-validate.mjs` reports "all .d.ts parse cleanly" because
`{ [key: string]: unknown }` is valid TypeScript. It just carries no contract,
so the design agent would have had no idea `EmptyState` takes
`icon`/`kicker`/`body`/`cta`. Baseline was 0/173 components with real props.

`lib/dts.mjs` extracts props two ways, and Janusly needed help with both:

1. **A named `<Name>Props` interface/type alias** anywhere in the declaration
   tree. Janusly has no declaration tree at all (no library build), so this
   found nothing. Fixed by emitting one:

   ```sh
   npx tsc -p tsconfig.app.json --declaration --emitDeclarationOnly --outDir types
   ```

   `findTypesRoot` probes `build/ts`, `dist/types`, `types`, `lib`, `dist` in
   that order, so a bare `types/` at the package root is discovered with no
   config key. This alone took it to 46/168.

   **Emit to `web/types/`, not `web/dist/types/`.** `dist/` is the application
   build's output directory: anything that runs `pnpm build` wipes it, and this
   checkout is regularly driven by more than one session at a time, so the
   declaration tree vanished mid-run twice. The symptom is confusing — the next
   `package-capture.mjs` fails with "run package-build.mjs first" — so if you
   see that, check `find types -name '*.d.ts' | wc -l` before anything else.

2. **The first call signature of the exported declaration**, looked up in the
   package's `.d.ts` *entry* module (`pkgJson.types` ?? `index.d.ts`). Most
   Janusly components use inline anonymous prop objects
   (`function QueueLagChip({ health }: { health: QueueHealth | null })`), so
   path 2 is the one that matters here — and it was resolving a
   `web/index.d.ts` that did not exist, silently returning `null`.
   `.design-sync/gen-dts-barrel.mjs` emits that barrel (generated, gitignored,
   repo-root). This took it to **153/168**.

**Known extractor limitation: nullable unions lose their `| null` arm.**
`PlaybookMatchCard.busy` is `'use' | 'retire' | null` in source but emits as
`"use" | "retire"`; `HealthRing.score` is `number | null` but emits as
`number`. The generated contract is therefore *narrower* than reality in both
cases, and `null` is often the meaningful idle/empty state. Where it matters
for composition the authored preview says so in its docblock. Pin the true
shape with `cfg.dtsPropsFor.<Name>` if a component's null case ever becomes
load-bearing for the design agent.

The remaining 15 genuinely take no props (store-connected panels declared
`function AuditLogPanel()`), plus the `ErrorBoundary` class. A bare index
signature would invite the agent to pass props that do nothing, so those are
pinned in `cfg.dtsPropsFor` — `ErrorBoundary`'s body is hand-written from
`src/components/ErrorBoundary.tsx`'s local `Props` type, which is **not**
exported and so cannot be resolved automatically. If that type changes, the
config entry goes stale silently — re-check it on a major refactor.

Both generator steps are part of `cfg.buildCmd`; running the converter without
them regresses every contract.

## i18n — the one non-obvious runtime requirement

257 call sites use `useT()`. Janusly's i18n runtime is a **module singleton**
that `main.tsx` fills in via `bootstrapI18n()` before React mounts; the DS
bundle has no equivalent entry point. The failure is silent rather than loud:
`resolveTemplate` falls through to `String(options?.defaultValue ?? key)`, so
cards render raw keys (`rightPanel.chrome.kicker`) instead of copy.

`.design-sync/ds-bootstrap.ts` (wired through `cfg.extraEntries`) fixes this by
registering the English catalog at bundle-init. It only needs
`registerRuntimeCatalog('en', …)` — the runtime's `activeLocale` already
defaults to `FALLBACK_LOCALE` (`'en'`), and calling `setRuntimeLocale` before
registration would throw.

If cards ever show dotted keys again, that module is the first place to look.

## Fonts

The repo ships **no font files** (`@font-face` count in the built CSS: 0). The
token stack is a deliberate system-font chain
(`"Inter Tight", "Avenir Next", "Inter", "Segoe UI", system-ui`), consistent
with the "dependency-free" invariant in `src/index.css`.

For Claude Design that would mean every generated design renders in whatever
the viewer's machine substitutes. **The user explicitly chose to ship the real
families** (2026-08-27), so `Inter Tight` and `JetBrains Mono` were fetched
from Google Fonts (OFL — redistribution permitted), localized into
`.design-sync/fonts/` (13 woff2 subsets, ~324 KB, zero remote references), and
wired via `cfg.extraFonts`. Those files are **committed** — they are sync
inputs, and re-fetching them is not reproducible.

This is a design-sync-only addition. It does **not** change what the Janusly
app itself ships, and must not be used to argue the app should adopt webfonts.

## Environment

- Playwright **1.61.1** (the repo's own pin) resolves `chromium-1228`, which is
  already in `~/Library/Caches/ms-playwright/`. No browser install needed.
- `ls -la` is aliased in this shell and returns nothing; use `/bin/ls -1` or
  `find` when scripting against this repo.
- BSD `sed` on macOS does not support `\L` — the font-URL rewrite uses node.

## Authoring previews for Janusly

- **Modals need an explicit stage.** The preview card wraps each cell in a
  `transform: translateZ(0)` element, which makes that cell the containing block
  for `position: fixed` descendants. Janusly's modal backdrops are
  `position: fixed; inset: 0`, so they resolve against the **cell**, not the
  viewport — and a content-sized cell collapses to ~48px, leaving the centred
  panel hanging 300px off the top of the card. Neither `cfg.overrides.viewport`
  nor `cardMode: single` fixes it, because the cell height is the problem. The
  fix lives in the preview: wrap the component in
  `<div style={{ minHeight: 760, position: 'relative' }}>`. See the `Stage`
  helper in `previews/RunInputDialog.tsx`, `HumanFormDialog.tsx`,
  `ShortcutsModal.tsx`.
- **The `fetch` stub is not purely cosmetic — some endpoints drive validity.**
  `ds-bootstrap.ts` answers every request with an empty 200 so panels show
  their designed empty state instead of an error banner. But
  `ScheduleCronPreview` asks the server whether a cron expression is valid and
  treats any response without `valid: true` **and exactly three** `nextFires`
  as invalid — so a perfectly good `0 2 * * *` rendered "Use a valid 5-field
  cron expression". The stub now routes on URL and returns a real payload for
  `/workflows/schedule-preview`. If another card ever shows a validation error
  on obviously-correct input, look here first.
- **Two collapse idioms, two different fixes.** Components that ship a closed
  `<details>` (`EvidencePanel`, `AlternativeHypothesesPanel`,
  `ResilienceFieldset`) open cleanly from a preview effect that sets
  `d.open = true`, and should — collapsed they show only a summary line.
  `RecoveryAutomationDisclosure` looks the same but is a controlled
  `useState` disclosure whose body is `lazy` + `Suspense`: clicking it open
  from an effect leaves the capture inside the suspense fallback and the card
  comes out **blank**. It is deliberately left collapsed.
- **Do not grade fine text off the contact/review sheets.** They are downscaled
  hard — a correct `in 5d` in `RecoveryItemBadge` reads as `in 840d` at sheet
  scale, and a subtly-tinted pill can look unstyled. Sheets are for layout and
  obvious breakage; verify text and computed style by loading the card and
  probing the DOM (`node .ds-sync/storybook/http-serve.mjs ./ds-bundle`, then
  `getComputedStyle` / `innerText` in a browser).
- **`WorkflowStepNode` cannot be previewed** and is deliberately left on the
  floor card. It renders React Flow `Handle`s, which need a
  `ReactFlowProvider` ancestor. Importing `ReactFlowProvider` from
  `@xyflow/react` inside the preview does not work: the preview compiles
  against `node_modules` while the component comes from the bundle, so the
  provider and the consumer end up in two different copies of the library and
  the render fails with "Seems like you have not used ReactFlowProvider as an
  ancestor" (reactflow.dev/error#001). The same applies to `WorkflowEdge`.
- **Three components have props that genuinely do not change their rendered
  output**, and their previews are deliberately single-cell rather than showing
  identical variants: `WorkflowOperationsPanel` (`readOnly` gates inside each
  control, which start collapsed), `ShortcutsModal` (every default shortcut is
  permission-free), and `SettingsOverview` (its section index comes from the
  store, so an isolated card always shows the empty-search state).
- **Tenant permission strings are dot-separated**, not colon-separated:
  `workflows.read`, `runs.read`, `recovery.read`, `members.read`,
  `credentials.read`, `packs.read`, `evals.read`, `ai.write` (the full map is
  `src/tab-permissions.ts`). A colon form like `workflows:read` matches nothing
  and fails **silently** — `WorkspaceSectionNav` renders an empty rail rather
  than erroring, which reads as a styling bug rather than bad data.
- **`WorkspaceSectionNav` renders `null` for `activeTab="home"`** — Home is its
  own destination with no section rail. A preview cell using it is an empty
  render, not a bug.
- **`CelebrationBurst` is deliberately left on the floor card.** It is a
  decorative CSS particle animation with no stable frame, so a static capture is
  either blank or arbitrary. Note that `cfg.overrides.<Name>.skip` takes a
  **list of story names**, not a boolean — passing `true` crashes the build in
  `lib/emit.mjs` with "boolean true is not iterable". With no authored preview
  the component already ships the floor card, so no override is needed.
- **`RecoveryItemBadge` accepts `item={null}`** and returns null. Supported, but
  it makes an empty card cell, so it is documented in the preview rather than
  shown as one.
- **Editing `cfg.overrides` clears every grade**, by design — overrides are
  preview-affecting config, so the grade contract changes. Batch override edits
  before a grading pass, not after one.

## Known render warns

These are triaged and expected. A warn line **not** in this list is new —
investigate it rather than assuming it is benign.

- `[FONT_MISSING] "Avenir Next", "Inter"` — both are *fallback* entries in the
  `--font-sans` chain, not the primary. `Inter Tight` (the primary) and
  `JetBrains Mono` do ship, so nothing actually renders in a substitute. Not
  worth resolving.
That is now the **only** warn the build emits: `package-validate.mjs` exits 0
with `168/168 previews render cleanly` and **zero** components on the
typographic floor card.

## Authoring round 2 — taking the floor card to zero

The first sync left 49 components on the typographic floor card. This round
authored all of them (plus a few that were rendering but poorly), reaching
**168/168 rendering cleanly, zero floor cards, 113 authored previews all graded
`good`**. The findings worth keeping:

### Store-gated components need a seed, and a card has ONE store

Several components render `null` until the app store holds something —
`ToastRenderer` needs a toast, `OnboardingBanner` an active onboarding row,
`WorkflowStatusPageCard` a selected *and saved* workflow, `RunStreamChip` a
`runId` **and** a non-idle transport. That state arrives at runtime, never from
props, so a preview has no other way in.

`ds-bootstrap.ts` re-exports the zustand store as `__previewStore`, and
`previews/_stage.tsx` wraps it in a `<Seed patch={…}>` helper that applies the
patch in a `useState` initializer (once, before children read it).

**The store is a singleton per card page.** Preview cells are not iframed, so
two stories on one card cannot hold different store states — the last seed
wins and both cells render it. Store-gated components therefore ship a **single
story**; props-driven ones keep their variants.

### React Flow is previewable after all — with one exception

The first round recorded the canvas components as impossible (two copies of
`@xyflow/react`: the preview compiles against `node_modules`, the component
comes from the bundle). That is only half right.

`CanvasWorkspace` **is** `<ReactFlowProvider><WorkflowCanvas /></ReactFlowProvider>`,
so mounting it puts provider and consumer in the same module instance and the
canvas renders. `RunObservationWorkspace` brings its own provider too. Both now
have real cards, and `WorkflowCanvas` / `WorkflowStepNode` / `WorkflowEdge` are
previewed *through* `CanvasWorkspace` — React Flow instantiates the real node
and edge components from the graph, so those cards show the actual components.

Two things are required and easy to miss:

- **Real height.** React Flow measures its container on mount; inside a
  content-sized cell it mounts and draws nothing. Every canvas preview wraps in
  a `div` with an explicit `height`.
- **Registered type keys.** Nodes need `type: 'workflowStep'` and edges
  `type: 'workflowEdge'`. Without them React Flow silently falls back to its own
  default renderers — the graph still draws, so this does **not** fail any check,
  but the card is no longer showing Janusly's components. An edge missing the
  key renders as a plain line with no condition/on-error label.

### Fixture gaps that render as content, not as errors

None of these failed a check; each was caught by reading the card.

- `RunObservationWorkspace` projects its canvas from `run.inputJson.workflow`.
  Without the snapshot the canvas half is simply blank.
- `ReviewBody` diffs against `dlq.workflowJson` and crashes on `{}`. A
  `DeadLetter` fixture without it is not a valid fixture.
- `EvidenceRow` is `{ kind, snippet, sourceRef }` — a `{ kind, summary }` row is
  scrubbed away and disappears.
- Edge `condition` strings are parsed by a **limited grammar**: comparisons,
  boolean composition, and dotted paths that must start with `context.` or
  `inputs.`. A bare word (`mismatch`) renders an inline validation error.
- Built-in snippet ids must be `builtin:<slug>` for a slug the catalog carries
  (`snippets.builtin.<slug>.name`); an invented slug renders the raw dotted key.
- Contradictory flags read as broken copy: `WorkspaceGate` with
  `selectionRequired: true` **and** an empty organization list renders "your
  account belongs to more than one organization" above nothing.

### Two sweeps worth re-running instead of re-reading 40 sheets

Both run off `ds-bundle/.render-check.json` after `package-validate.mjs`:

```sh
# 1. placeholder garbage that reached the DOM
node -e "const rc=require('./ds-bundle/.render-check.json');const bad=/undefined|NaN|\[object Object\]|Infinity/;
for(const r of rc) if((r.texts||[]).some(t=>bad.test(t))) console.log(r.name)"

# 2. raw i18n keys (filter by real catalog prefixes; hostnames are false hits)
node -e "const rc=require('./ds-bundle/.render-check.json');const cat=require('./src/i18n/locales/en/common.json');
const pre=new Set(Object.keys(cat).map(k=>k.split('.')[0]));
for(const r of rc) for(const t of (r.texts||[])) for(const m of t.matchAll(/\b([a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9_-]+){1,5})\b/g))
  if(pre.has(m[1].split('.')[0])) console.log(r.name, m[1])"
```

The first found three components rendering `undefined` / `[object Object]`; the
second confirmed no leaked keys. `r.texts` is **not** one entry per story
(counts only line up for some components), so it is a good garbage detector and
a bad blank-cell detector.

### Read the DOM, not the sheet, for anything small

Twice this round a downscaled contact sheet read wrong — a relative time that
said "just now" was actually "2d ago", and `AuthoringPanel`'s `ReadOnly` cell
looked identical to `WithoutAi` until a probe showed the whole step form wrapped
in `fieldset[disabled]` (note: an input inside a disabled fieldset does **not**
have `.disabled === true`; query `fieldset[disabled]` or match `:disabled`).
Serve the bundle and probe:

```sh
node .ds-sync/storybook/http-serve.mjs ./ds-bundle
```

### One production defect found, one filed

- **Fixed earlier:** `SemanticOutcomePill` emitted `data-tone="warn"`, which
  matches no CSS rule. A ratchet test now greps `platform.css` for the tones the
  pill stylesheet actually defines.
- **Also fixed:** `RecoveryDialog`'s cluster line printed the match count twice
  — "matches 3 3 open DLQ entries", and "matches 3 of 31 3 open DLQ entries"
  when capped — because a `<strong>` and a counted i18n string each rendered it.
  The counted `clusterEntries` key was replaced with a noun-only
  `clusterEntriesNoun`, so the number lives only in the `<strong>`. The noun
  agrees with the **total** when capped, not the visible slice: one entry out of
  thirty-one is still "entries". Three regression tests cover it.

### Layout overrides are grade-safe

`cardMode` and `primaryStory` are deliberately excluded from the grade key
(`KEY_RECIPE = 7` in `lib/sync-hashes.mjs`), so adding them to `cfg.overrides`
to clear `[GRID_OVERFLOW]` carries every existing grade forward. `viewport` and
`skip` are keyed and do wipe grades. A render that actually changes is caught by
`renderHash` regardless.

## Re-sync risks

What can silently go stale, roughly in order of how likely it is to bite:

- **The per-clone setup is not in the config.** A fresh checkout needs the
  `node_modules/@janusly/web` symlink directory (step 1) and a `cfg.buildCmd`
  run before anything works. Both are the most likely first failure.
- **`compiled.css`, `types/` and `index.d.ts` are generated and gitignored.**
  Skipping `cfg.buildCmd` runs the converter against stale or missing inputs.
  Sanity checks that catch it fast: `wc -c ds-bundle/_ds_bundle.css` ≈ 330 KB,
  `grep -c -- '--theme(' ds-bundle/_ds_bundle.css` = 0, and
  `find types -name '*.d.ts' | wc -l` ≈ 274.
- **`.design-sync/overrides/source-kit.mjs` is a fork.** On a converter
  upgrade, diff it against the bundled `lib/source-kit.mjs` and merge. Its only
  change is the `APP_ENTRY_RX` filter; if upstream ever excludes app entries
  itself, delete the fork and its `cfg.libOverrides` entry.
- **`ds-bootstrap.ts` reads live repo files** — `src/i18n/locales/en/common.json`
  and `src/i18n/runtime`. Nothing is inlined, so it stays current on its own,
  but a move or an API change breaks it with **dotted i18n keys in the cards**
  rather than a build error.
- **The `fetch` stub is a content surface, not just a crash guard.** It now
  routes ~20 endpoints (see `ROUTES` in `ds-bootstrap.ts`). A component that
  starts reading a route the table does not answer gets `{}`, and the failure
  mode depends on how it reads: a guarded component renders an honest empty
  state, an unguarded one throws (`FailureClustersCard` destructured
  `clusters.length` off `{}` and took its whole card down). Anything that
  *derives* content from a response — a cron's validity, a cohort's eligible
  count, a health score — shows something false until the stub learns the
  route.
- **`cfg.dtsPropsFor.ErrorBoundary` is hand-written** from a non-exported local
  `Props` type in `src/components/ErrorBoundary.tsx`. Nothing detects drift —
  re-read it on any refactor of that file.
- **113 of 168 components have an authored, graded preview; 55 do not.** The
  55 render through the converter's default no-props card, pass the render
  check, and ship **ungraded** — that is the same state the first sync left
  them in, not a regression. The known-weak one is `QueueLagChip`, whose
  default state is "queue status unavailable" because it reads the queue store
  rather than an endpoint the stub can answer.
- **Build assumptions:** node 24 (`.nvmrc`), pnpm 11.17, playwright 1.61.1 with
  chromium-1228 already cached, and the Google-Fonts woff2 files committed under
  `.design-sync/fonts/` (never re-fetched, so the build is reproducible offline).
