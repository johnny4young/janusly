/**
 * Focus management for a modal dialog. Handles both common Janusly patterns:
 *  - Mount-per-open dialogs (rendered only while open): call
 *    `useDialogFocusTrap(ref)` — `active` defaults to true for the dialog's
 *    lifetime, and focus is restored when it unmounts.
 *  - Always-mounted, `open`-prop dialogs (render null while closed): call
 *    `useDialogFocusTrap(ref, { active: open })` — focus is captured when
 *    `open` flips true and restored when it flips false.
 *
 * What it does while active:
 *  - Captures the element that had focus when the dialog opened (read before the
 *    dialog moves focus inward) and restores focus to it on close / unmount.
 *  - Traps Tab / Shift+Tab so focus wraps within the dialog instead of escaping
 *    to the background. It only acts while focus is already inside the dialog,
 *    so it never yanks focus from a nested dialog or the page.
 *  - With `initialFocus: true`, focuses the first focusable on open. A ref can
 *    select a preferred initial control and falls back to the first focusable
 *    if that control is unavailable.
 *
 * Used by every `aria-modal="true"` surface in the app. Dialog-specific Escape
 * and state-machine behavior remains with each component.
 */

import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ')

const MAX_INITIAL_FOCUS_FRAMES = 4

export function useDialogFocusTrap(
  dialogRef: RefObject<HTMLElement | null>,
  options?: {
    active?: boolean
    initialFocus?: boolean | RefObject<HTMLElement | null>
    /** Called on Escape while the trap is active; undefined leaves Escape alone (e.g. mid-submit). */
    onEscape?: () => void
  },
): void {
  const active = options?.active ?? true
  const initialFocus = options?.initialFocus ?? false
  // Read through a ref so a new callback identity never re-subscribes.
  const onEscapeRef = useRef(options?.onEscape)
  onEscapeRef.current = options?.onEscape
  useEffect(() => {
    if (!active) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !onEscapeRef.current) return
      event.preventDefault()
      onEscapeRef.current()
    }
    // On window, where the dialogs listened before: a keydown reaches it
    // whether dispatched on the document or on the window itself.
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [active])

  // Capture the trigger at the render where `active` flips on — before the
  // dialog's own initial-focus moves focus inward — so it can be restored when
  // the dialog closes. (Guarded ref write during render: idempotent.)
  const triggerRef = useRef<HTMLElement | null>(null)
  const initialFocusFrameRef = useRef<number | null>(null)
  const restoreFrameRef = useRef<number | null>(null)
  const prevActive = useRef(false)
  if (active && !prevActive.current) {
    prevActive.current = true
    if (typeof document !== 'undefined') {
      triggerRef.current = document.activeElement as HTMLElement | null
    }
  } else if (!active && prevActive.current) {
    prevActive.current = false
  }

  useEffect(() => {
    if (!active) return
    // React Strict Mode runs setup → cleanup → setup once on mount. Cancel the
    // first cleanup's pending restoration so it cannot steal focus from the
    // live dialog after the second setup focuses its initial control.
    if (restoreFrameRef.current !== null) {
      cancelAnimationFrame(restoreFrameRef.current)
      restoreFrameRef.current = null
    }
    if (initialFocusFrameRef.current !== null) {
      cancelAnimationFrame(initialFocusFrameRef.current)
      initialFocusFrameRef.current = null
    }
    const preferredInitialFocus = typeof initialFocus === 'object' ? initialFocus : null

    const focusInitialControl = (): boolean => {
      const root = dialogRef.current
      if (!root) return false
      const firstFocusable = root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)[0]
      const preferred = preferredInitialFocus?.current ?? null
      const target = preferred && root.contains(preferred) && preferred.matches(FOCUSABLE_SELECTOR)
        ? preferred
        : firstFocusable
      target?.focus()
      return root.contains(document.activeElement)
    }

    if (initialFocus) {
      const verifyInitialFocus = (remainingFrames: number) => {
        const root = dialogRef.current
        if (root?.contains(document.activeElement)) return
        if (focusInitialControl() || remainingFrames <= 0) return
        initialFocusFrameRef.current = requestAnimationFrame(() => {
          initialFocusFrameRef.current = null
          verifyInitialFocus(remainingFrames - 1)
        })
      }
      // An always-mounted dialog can still be inert during the opening commit,
      // or an off-canvas visibility transition may not be focusable during the
      // first style frames. Retry only while focus remains outside and keep the
      // sequence tightly bounded.
      initialFocusFrameRef.current = requestAnimationFrame(() => {
        initialFocusFrameRef.current = null
        verifyInitialFocus(MAX_INITIAL_FOCUS_FRAMES - 1)
      })
      focusInitialControl()
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return
      const node = dialogRef.current
      // Only trap while focus is already inside this dialog.
      if (!node || !node.contains(document.activeElement)) return
      const focusables = Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
      if (focusables.length === 0) return
      const first = focusables[0]!
      const last = focusables[focusables.length - 1]!
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      if (initialFocusFrameRef.current !== null) {
        cancelAnimationFrame(initialFocusFrameRef.current)
        initialFocusFrameRef.current = null
      }
      // Restore focus to the trigger on close / unmount (if it still exists).
      const trigger = triggerRef.current
      if (trigger && document.contains(trigger)) {
        restoreFrameRef.current = requestAnimationFrame(() => {
          restoreFrameRef.current = null
          trigger.focus()
          if (triggerRef.current === trigger) triggerRef.current = null
        })
      }
    }
  }, [active, initialFocus, dialogRef])
}
