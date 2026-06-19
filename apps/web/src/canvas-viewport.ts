/**
 * Per-workflow canvas viewport (zoom + pan) persistence.
 *
 * The workflow editor's React Flow viewport is uncontrolled (it fits-to-view on
 * mount), so it resets whenever the canvas instance unmounts/remounts — a home
 * round-trip or an F5 reload. These helpers persist the last user-set viewport
 * to `localStorage` per workflow so `WorkflowCanvas` can restore it as the
 * initial `defaultViewport` on the next mount.
 *
 * Defensive in the same way as the locale/theme storage helpers: every access is
 * guarded (storage may be absent in non-browser/test contexts, or throw in
 * private mode / on quota) and a corrupt or wrong-shaped value degrades to null.
 *
 * Used by `apps/web/src/components/WorkflowCanvas.tsx`.
 */

import type { Viewport } from '@xyflow/react'

const KEY_PREFIX = 'janusly:canvasViewport:'

/** True only for a `{ x, y, zoom }` object with finite pan coordinates and a
 *  positive finite zoom — rejects a corrupt / outdated / partial localStorage
 *  value. `Number.isFinite` (not the coercing global `isFinite`) means a
 *  stringified number is also rejected. */
function isViewport(value: unknown): value is Viewport {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.zoom) && (v.zoom as number) > 0
}

/** Read the saved viewport for a workflow, or `null` when none / unavailable /
 *  corrupt. Safe to call during render. */
export function readCanvasViewport(workflowId: string): Viewport | null {
  if (typeof window === 'undefined' || !window.localStorage) return null
  try {
    const raw = window.localStorage.getItem(KEY_PREFIX + workflowId)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    return isViewport(parsed) ? { x: parsed.x, y: parsed.y, zoom: parsed.zoom } : null
  } catch {
    return null
  }
}

/** Persist a workflow's viewport; failure is non-fatal (storage unavailable /
 *  private mode / quota). Only the `{ x, y, zoom }` triple is stored. */
export function writeCanvasViewport(workflowId: string, viewport: Viewport): void {
  if (typeof window === 'undefined' || !window.localStorage) return
  try {
    window.localStorage.setItem(
      KEY_PREFIX + workflowId,
      JSON.stringify({ x: viewport.x, y: viewport.y, zoom: viewport.zoom }),
    )
  } catch {
    /* swallow — storage may be unavailable (private mode / quota). */
  }
}
