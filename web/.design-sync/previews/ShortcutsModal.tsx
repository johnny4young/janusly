import type { ReactNode } from 'react'
import { ShortcutsModal } from '@janusly/web'

/**
 * The keyboard-shortcut reference, opened with `?`.
 *
 * `permissions` filters the listing, but every shortcut in the default set is
 * permission-free — palette navigation, sidebar focus, sign out — so a
 * narrower role sees the same list. Only one cell is shown rather than two
 * identical ones.
 */

/**
 * Overlay stage. The preview card wraps each cell in a
 * `transform: translateZ(0)` element, which makes that cell the containing
 * block for `position: fixed` descendants. Janusly modal backdrops are
 * `position: fixed; inset: 0`, so they resolve against the CELL, not the
 * viewport — and a content-sized cell collapses to a few dozen pixels, leaving
 * the centred panel hanging off the top. An explicit height fixes both.
 */
function Stage({ children }: { children: ReactNode }) {
  return <div style={{ minHeight: 760, position: 'relative' }}>{children}</div>
}

/** Open, with the full shortcut set. */
export function Open() {
  return (
    <Stage>
      <ShortcutsModal
        open
        onClose={() => {}}
        permissions={['workflows.read', 'runs.read', 'recovery.read', 'members.read']}
      />
    </Stage>
  )
}
