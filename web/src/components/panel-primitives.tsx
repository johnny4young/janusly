/**
 * Shared layout primitives for the right-side workspace panel family —
 * `PanelChrome` (the heading + body wrapper used by every tab) and
 * `EmptyView` (the empty-state slot used by templates / tools /
 * credentials / runs / reasoning).
 *
 * Extracted from `RightPanel.tsx` so sibling panel files (`RunsPanel.tsx`,
 * `InspectorPanel.tsx`, etc.) can import them without re-importing from
 * `RightPanel.tsx` — which would create a circular import via the
 * `RightPanel.tsx → RunsPanel.tsx` dispatcher edge.
 *
 * Used by:
 * - `RightPanel.tsx` — dispatcher + small panels (Templates / Tools /
 *   Credentials / Reasoning) wrap themselves in `PanelChrome`; the four
 *   small panels also render `EmptyView` for their empty list states.
 * - `RunsPanel.tsx` — wraps in `PanelChrome`; renders `EmptyView` in the
 *   run-history empty state.
 */

import React from 'react'
import { Search } from 'lucide-react'
import { EmptyState } from './EmptyState'

/** Names a panel for assistive technology. The visible title is the section
 *  navigation row above it, so a view has one header. */
export function PanelChrome({
  title,
  children,
  description,
}: {
  title: string
  children: React.ReactNode
  description?: string
}) {
  return (
    <div className="panel-stack">
      <h2 className="we-sr-only">{title}</h2>
      {description && <p className="we-sr-only">{description}</p>}
      {children}
    </div>
  )
}

/**
 * Thin adapter kept for the panel call sites (Templates / Tools / Credentials /
 * Reasoning / Runs / Packs). Delegates to the canonical `EmptyState` so every
 * empty state shares one implementation + look — `title` maps to EmptyState's
 * `kicker`.
 */
export function EmptyView({
  icon,
  title,
  body,
  cta,
  secondary,
}: {
  icon: React.ReactNode
  title: string
  body: string
  /** Optional call-to-action — forwarded to `EmptyState` so a panel empty state
   *  can offer a next step (generate a template, clear a filter, …). */
  cta?: { label: string; onClick: () => void }
  secondary?: { label: string; href: string }
}) {
  return <EmptyState icon={icon} kicker={title} body={body} cta={cta} secondary={secondary} />
}

/**
 * Inline search/filter box for list panels (Templates / Packs). The parent owns
 * the query state + filtering; this is just the labelled input affordance,
 * mirroring the sidebar search look.
 */
export function PanelSearch({
  value,
  onChange,
  placeholder,
}: {
  value: string
  onChange: (value: string) => void
  placeholder: string
}) {
  return (
    <div className="we-panel-search">
      <Search size={16} aria-hidden="true" />
      <input
        type="text"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
      />
    </div>
  )
}
