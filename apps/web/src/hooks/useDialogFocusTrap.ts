/**
 * Focus management for a mount-per-open modal dialog. Add it to a dialog
 * component that mounts when opened and unmounts when closed (the common
 * Janusly pattern): pass a ref to the dialog's root element.
 *
 * What it does:
 *  - Captures the element that had focus when the dialog opened (read at the
 *    first render, before the dialog moves focus inward) and restores focus to
 *    it when the dialog unmounts.
 *  - Traps Tab / Shift+Tab so keyboard focus wraps within the dialog instead of
 *    escaping to the background. It only acts while focus is already inside the
 *    dialog, so it never yanks focus away from a nested dialog or the page.
 *
 * What it does NOT do: it does not set the initial focus (pass
 * `initialFocus: true` to opt in) — most dialogs already focus their primary
 * control, and double-focusing would fight that.
 *
 * Used by the app's modal dialogs (RunInput, Recovery, ReplayLab, Rollback,
 * ReportDelivery, CredentialRotate, CommandPalette, Shortcuts, …). The
 * always-mounted ConfirmDialog provider manages focus itself (it can't use a
 * mount-based capture) — see `ConfirmDialog.tsx`.
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
  options?: { initialFocus?: boolean },
): void {
  // Capture the trigger during the first render — before the dialog's own
  // initial-focus effect moves focus inward — so it can be restored on close.
  const triggerRef = useRef<HTMLElement | null>(null)
  if (triggerRef.current === null && typeof document !== 'undefined') {
    triggerRef.current = document.activeElement as HTMLElement | null
  }

  const initialFocus = options?.initialFocus ?? false

  useEffect(() => {
    const root = dialogRef.current

    if (initialFocus && root) {
      const focusables = root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
      focusables[0]?.focus()
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return
      const node = dialogRef.current
      // Only trap while focus is already inside this dialog — avoids fighting a
      // nested dialog or the page for focus.
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
      // Restore focus to the trigger if it's still in the document.
      const trigger = triggerRef.current
      if (trigger && document.contains(trigger)) {
        // Defer so the dialog has fully unmounted before focus moves.
        requestAnimationFrame(() => trigger.focus())
      }
    }
  }, [dialogRef, initialFocus])
}
