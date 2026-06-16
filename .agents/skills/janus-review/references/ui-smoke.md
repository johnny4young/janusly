# UI smoke protocol — focused, overlay-free, state-by-state

A UI smoke proves the **ticket's own surface** works in a real browser. A
full-page screenshot of the whole app — sidebar, header, footer, and some
unrelated overlay (onboarding banner, toast, budget banner) sitting on top of
the change — is **NOT evidence**. It is generic, it usually hides the very thing
the ticket touched, and it must be rejected and retaken.

This protocol is the single source of truth for both `janus-review` (validating
the reviewer's own inline UI fixes, and confirming a UI-heavy staged diff) and
`janus-ship`.

## When a UI smoke is required

- **janus-review:** the reviewer's OWN inline fix changed a web surface
  (`apps/web/**` component, panel, toast, overlay, affordance, or copy) — the
  smoke is MANDATORY. ALSO: when the staged diff is UI-heavy and the implementer
  left no evidence or only a generic full-page frame, run a confirming smoke of
  the ticket's surface so the review actually validates the change.
- **janus-ship:** the diff adds or changes ANY `apps/web/**` surface a user sees.

If the change is purely non-visual (types, tests, backend, a hook with no
rendered output), say so in the report and skip — but a rendered change always
needs a focused smoke.

## The five rules

### 1. Focus the ticket's surface — never the whole app
- Screenshot the specific element / section the ticket changed, addressed by its
  snapshot ref or a unique selector (Playwright **element** screenshot via the
  `element` + `ref`/`target` args), NOT `fullPage`. The change must be the visual
  subject of the frame.
- If the surface is tiny (a button, a pill), capture its enclosing panel/card so
  the change reads in context — still not the entire viewport chrome.
- `fullPage: true` of the app shell is the anti-pattern this rule exists to kill.

### 2. Hide unrelated overlays before capturing
- The onboarding banner, toasts, the budget-blocked banner, the command palette,
  and any modal NOT under test obstruct the surface and make the frame generic.
- Remove them first — by dismissing via their own control (Skip / close), or by
  injecting CSS through `browser_evaluate`, e.g.:
  ```js
  () => {
    for (const sel of ['[role="status"]', '.we-toast', '.we-onboarding-banner',
                        '.we-budget-blocked-banner', '[data-overlay]']) {
      document.querySelectorAll(sel).forEach((el) => { el.style.display = 'none' })
    }
  }
  ```
  (Match the real selectors from the snapshot — confirm by inspecting, don't guess.)
- **Inverse case:** when the fix's OWN surface IS a modal/overlay/drawer, open it
  and capture it open — and hide everything else competing for the frame.

### 3. Capture the states the fix introduces — not one screen
- A UI change has states. Capture each meaningful one the fix adds or alters,
  one PNG per state:
  - the **default** (the surface as first rendered),
  - the **interacted** state (hover / clicked / disabled / loading / focused),
  - the **result** (expanded / appended / submitted / filtered),
  - the **empty** state, and the **error** state when reachable.
- Example — a "Load more" button: (a) present with the list, (b) disabled while
  the next page loads, (c) list appended after the click, (d) button gone when
  the queue is exhausted. Four states, four frames — not one.

### 4. Prove the frame shows the change before you save it
- Before each screenshot, assert via `browser_snapshot` or a `browser_evaluate`
  DOM probe that the surface's element is **present, visible, in the expected
  state, and not covered**. A frame where the change is off-screen, behind an
  overlay, or on the wrong view is invalid — navigate / scroll-into-view / hide
  the obstruction and retake.
- This probe is also your functional assertion (e.g. row count went 50 → 100,
  button text is the new copy, the disabled attribute flipped). Record the probe
  result in the report alongside the PNG.

### 5. Name + locate by surface AND state; both locales when copy changed
- Artifacts go under `output/review/eng-NNN/` (review) or
  `output/janus-ship/eng-NNN/` (ship). Both are gitignored — never `git add` a PNG.
- Filename: `web-<locale>-<surface>-<state>.png`. Examples:
  - `web-en-recovery-queue-load-more-default.png`
  - `web-en-recovery-queue-load-more-loading.png`
  - `web-en-recovery-queue-load-more-exhausted.png`
  - `web-es-recovery-queue-load-more-default.png`
- When the fix touches copy, capture the changed surface in BOTH locales
  (`en` + `es`) so the translation is visually confirmed, not just parity-tested.
- Console must be **0 errors** — check `browser_console_messages` at level
  `error` after exercising the surface.

## Seed the ticket's data, not an empty org

The surface must show REAL ticket data — the rows, the new control, the changed
copy — in the state the change is about. Seed enough state to exercise it (e.g.
MORE than one page when the change is pagination; a mix of statuses when it is a
filter) and point the browser at that org (set `localStorage['janusly:activeOrg']`
to the seeded org, or seed the dev org `default`). An empty surface, or a surface
showing one row when the feature is about many, proves nothing.

## Report the evidence honestly

List each PNG path AND the state it shows on the report's Gates line, with the
DOM-probe result that backs it. If a state was genuinely unreachable (gated by
role / flag / seed you can't satisfy with the dev seed), say so explicitly and
lean on the component/unit test for that state — never pass off a generic or
wrong-state frame as the missing evidence.
