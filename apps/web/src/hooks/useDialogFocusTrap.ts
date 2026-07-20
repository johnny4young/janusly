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

export function useDialogFocusTrap(
  dialogRef: RefObject<HTMLElement | null>,
  options?: {
    active?: boolean
    initialFocus?: boolean | RefObject<HTMLElement | null>
  },
): void {
  const active = options?.active ?? true
  const initialFocus = options?.initialFocus ?? false

  // Capture the trigger at the render where `active` flips on — before the
  // dialog's own initial-focus moves focus inward — so it can be restored when
  // the dialog closes. (Guarded ref write during render: idempotent.)
  const triggerRef = useRef<HTMLElement | null>(null)
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
    const root = dialogRef.current

    if (initialFocus && root) {
      const firstFocusable = root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)[0]
      const preferred = initialFocus === true ? null : initialFocus.current
      const target = preferred && root.contains(preferred) && preferred.matches(FOCUSABLE_SELECTOR)
        ? preferred
        : firstFocusable
      target?.focus()
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
