/**
 * Shared preview harness.
 *
 * NOT a component preview — the converter only treats `previews/<ComponentName>.tsx`
 * as an entry, so this is bundled by whichever preview imports it and never
 * emits a card of its own. (The build logs it as a "stale preview"; that line
 * is expected.)
 */

import { useState, type ReactNode } from 'react'
// Preview-only harness export from `.design-sync/ds-bootstrap.ts`. Not part of
// the design system's public API, and deliberately absent from `index.d.ts`.
// @ts-expect-error -- runtime-only export, see ds-bootstrap.ts
import { __previewStore } from '@janusly/web'

/**
 * Gives a dialog or drawer room to lay out.
 *
 * Preview cards wrap every cell in `transform: translateZ(0)`, which makes the
 * cell — not the viewport — the containing block for `position: fixed`. Without
 * an explicit height a modal backdrop collapses to a ~48px strip and the dialog
 * is cropped.
 */
export function Stage({ children, minHeight = 760 }: { children: ReactNode; minHeight?: number }) {
  return <div style={{ minHeight, position: 'relative' }}>{children}</div>
}

/**
 * Seeds the app store before the wrapped subtree mounts.
 *
 * Several components read runtime state the app shell supplies and render
 * `null` until it is there. The patch is applied in a `useState` initializer so
 * it lands once, during the first render, before children read the store.
 *
 * **One store per card page.** All cells on a card share the singleton, so
 * seeding different states in two stories does not work — the last one wins.
 * Components that depend on this ship a single story.
 */
export function Seed({ patch, children }: { patch: Record<string, unknown>; children: ReactNode }) {
  useState(() => {
    ;(__previewStore as { setState: (p: Record<string, unknown>) => void }).setState(patch)
    return null
  })
  return <>{children}</>
}
