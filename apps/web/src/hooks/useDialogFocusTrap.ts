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
 *  - With `initialFocus: true`, focuses the first focusable on open (use for
 *    dialogs that don't focus a control themselves, e.g. ShortcutsModal).
 *
 * Used by the app's modal dialogs. The always-mounted ConfirmDialog provider
 * manages focus itself (it can't use this) — see `ConfirmDialog.tsx`.
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
  options?: { active?: boolean; initialFocus?: boolean },
): void {
  const active = options?.active ?? true
  const initialFocus = options?.initialFocus ?? false

  // Capture the trigger at the render where `active` flips on — before the
  // dialog's own initial-focus moves focus inward — so it can be restored when
  // the dialog closes. (Guarded ref write during render: idempotent.)
  const triggerRef = useRef<HTMLElement | null>(null)
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
    const root = dialogRef.current

    if (initialFocus && root) {
      root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)[0]?.focus()
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
      triggerRef.current = null
      if (trigger && document.contains(trigger)) {
        requestAnimationFrame(() => trigger.focus())
      }
    }
  }, [active, initialFocus, dialogRef])
}
