import { PanelChrome } from '@janusly/web'
import { Boxes, History } from 'lucide-react'

/**
 * The heading + body wrapper every right-side workspace panel opens with.
 * `kicker` defaults to the "Workspace" label when omitted; `description` and
 * `icon` are the optional refinements panels use to orient the operator.
 */

/** The full composition — kicker, title, description, icon, and real body copy. */
export function FullHeading() {
  return (
    <PanelChrome
      kicker="Operations"
      title="Run history"
      description="Every execution of this workflow, newest first, with the outcome the engine recorded."
      icon={<History size={18} />}
    >
      <p style={{ margin: 0, color: 'var(--we-text-2)', fontSize: 13, lineHeight: 1.6 }}>
        Runs are retained for 90 days. Selecting one opens its timeline, the
        inputs it received, and the reasoning the operator captured at each
        step. Failed runs keep their dead-letter reference so a replay can be
        started without re-entering the original payload.
      </p>
    </PanelChrome>
  )
}

/** Title only — the minimal form, with the default kicker. */
export function TitleOnly() {
  return (
    <PanelChrome title="Templates">
      <p style={{ margin: 0, color: 'var(--we-text-2)', fontSize: 13 }}>
        Reusable starting points for new workflows.
      </p>
    </PanelChrome>
  )
}

/** Heading with an icon but no description. */
export function WithIcon() {
  return (
    <PanelChrome kicker="Catalog" title="Solution packs" icon={<Boxes size={18} />}>
      <p style={{ margin: 0, color: 'var(--we-text-2)', fontSize: 13 }}>
        Packs bundle a workflow, its credentials, and its alert policy.
      </p>
    </PanelChrome>
  )
}
