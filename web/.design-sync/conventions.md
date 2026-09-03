# Building with Janusly

Janusly is the AI operator for business workflows. Its UI is a **dependency-free,
hand-written design system**: no Tailwind utilities, no CSS-in-JS, no component
library underneath. Every visual decision is a named CSS class plus a `--we-*`
token, and the class vocabulary is enforced in CI — a class with no owner in
production source fails the lint. Invent a class name and it is, by definition,
not Janusly.

## Setup

No provider is required. Import a component and render it; tokens live on
`:root` in the stylesheet, so anything inside the page is already themed.

**Theme** is an attribute on the root element, not a wrapper:
`<html data-theme="dark">` (absent = light). Both palettes are defined in the
shipped CSS; never hard-code a hex value, or dark mode silently breaks.

**Copy is translated.** Components call `useT()` internally, so labels come from
the bundled English catalog — you pass *data*, not display strings, wherever a
prop is an enum. `SemanticOutcomePill` takes `status="semantic_recovered"` and
renders "Outcome recovered" itself.

## The styling idiom

Two things carry the design language: a **class name** and, for variants, a
**`data-*` attribute**. Modifiers are BEM-style (`__element`, `--modifier`).

| Family | Real names |
|---|---|
| Buttons | `we-btn` + `we-btn--primary` / `we-btn--ghost` / `we-btn--sm`; `small-command` for inline row actions |
| Pills / badges | `we-pill`, `status-pill` — tone via `data-tone` |
| Surfaces | `we-card`, `list-card`, `list-card-row`, `split-row`, `detail-block` |
| Panel chrome | `panel-stack`, `panel-heading`, `section-kicker` |
| Forms | `field-label`, `text-field`, `helper-text`, `we-panel-search` |
| States | `we-empty-state`, `we-skeleton` |
| Mono | `mini-pre`, `inspector-meta` |

Feature-scoped blocks follow `we-<feature>__<element>`, e.g.
`we-recovery-center-hero__greeting`, `we-ops-metric-card__label`.

**`data-tone` is the variant axis** and its accepted values are exactly:
`primary`, `neutral`, `info`, `success`, `warning`, `danger`, `ghost`. There is
no `warn` — a tone name outside that set matches no rule and renders unstyled.

## Tokens

Use `var(--we-*)`; never a literal colour.

- Brand: `--we-primary`, `--we-accent`
- Surfaces: `--we-bg`, `--we-surface`, `--we-surface-2`, `--we-surface-3`, `--we-line`
- Text: `--we-text-1` (primary), `--we-text-2` (secondary), `--we-muted`
- Status: `--we-success`, `--we-warning`, `--we-danger`, `--we-info` — each with
  a `-soft` (fill) and `-text` (readable-on-light) companion. **Use the `-text`
  variant for text and icons**; the saturated value fails WCAG AA on light
  surfaces.
- Type: `--font-sans` (Inter Tight), `--font-mono` (JetBrains Mono)
- Shape: `--we-radius-pill`

## Where the truth lives

Read `_ds/<folder>/styles.css` and its `@import` closure before styling anything
— it is the complete, real stylesheet, and it beats this summary. Each
component's own contract is in its `<Name>.d.ts`; its usage notes are in
`<Name>.prompt.md`.

## An idiomatic composition

Library components for the controls, Janusly's own classes for your layout glue:

```jsx
<div className="we-card">
  <div className="panel-heading">
    <div className="panel-heading-copy">
      <div className="section-kicker">Operations</div>
      <h2>Run history</h2>
    </div>
  </div>

  <VitalSignsStrip
    ariaLabel="Run vitals"
    tiles={[
      { icon: <TrendingUp size={15} />, label: 'Success rate',
        display: '99.2%', severity: 'healthy', progressValue: 99 },
    ]}
  />

  <div className="split-row">
    <SemanticOutcomePill status="semantic_recovered" />
    <span className="helper-text" style={{ color: 'var(--we-text-2)' }}>
      Recovered on the first retry.
    </span>
  </div>

  <button type="button" className="we-btn we-btn--primary we-btn--sm">
    Open run
  </button>
</div>
```

When a list has nothing in it, reach for `EmptyState` rather than writing a
one-off — every empty surface in Janusly is that component.
