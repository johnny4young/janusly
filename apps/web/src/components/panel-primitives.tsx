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
import { useT } from '../i18n'
import { EmptyState } from './EmptyState'

export function PanelChrome({
  title,
  children,
  kicker,
  description,
  icon,
}: {
  title: string
  children: React.ReactNode
  kicker?: string
  description?: string
  icon?: React.ReactNode
}) {
  const { t } = useT()
  const resolvedKicker = kicker ?? (t('rightPanel.chrome.kicker') as string)
  return (
    <div className="panel-stack">
      <div className="panel-heading">
        <div className="panel-heading-copy">
          <div className="section-kicker">{resolvedKicker}</div>
          <h2>{title}</h2>
          {description && <p>{description}</p>}
        </div>
        {icon && <span className="panel-heading-icon">{icon}</span>}
      </div>
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
export function EmptyView({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return <EmptyState icon={icon} kicker={title} body={body} />
}
