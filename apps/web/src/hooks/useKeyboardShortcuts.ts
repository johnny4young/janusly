/**
 * Global keyboard-shortcut listener for the Janusly Studio shell. Owns the
 * single `document` keydown handler that drives the command palette, the
 * keyboard-shortcuts overlay, the sidebar-search focus jump, and sign-out.
 * Extracted from `App` so the shell isn't carrying the raw DOM listener inline.
 *
 * Used by:
 * - `apps/web/src/App.tsx`
 *
 * Shortcuts:
 *   Cmd/Ctrl+K   — toggle command palette
 *   ?            — toggle keyboard-shortcuts overlay (when not typing in a field)
 *   /            — focus the sidebar search (when not typing in a field)
 *   Ctrl+Shift+Q — sign out (matches the kbd shown in the user menu)
 */

import { useEffect } from 'react'

/** Callbacks the shell wires into the global shortcut handler. */
export type KeyboardShortcutHandlers = {
  /** Toggle the command palette (Cmd/Ctrl+K). */
  onTogglePalette: () => void
  /** Toggle the keyboard-shortcuts overlay (`?`). */
  onToggleShortcuts: () => void
  /**
   * Focus the sidebar search (`/`). Returns `true` when a search input was
   * found and focused so the handler can suppress the default `/` keypress
   * only in that case (mirrors the original conditional `preventDefault`).
   */
  onFocusSidebarSearch: () => boolean
  /** Sign the operator out (Ctrl+Shift+Q). */
  onSignOut: () => void
}

/**
 * Registers a `document` keydown listener for the shell's global shortcuts and
 * tears it down on unmount. The `?` and `/` shortcuts no-op while the user is
 * typing in an `<input>` / `<textarea>` / contenteditable element.
 */
export function useKeyboardShortcuts({ onTogglePalette, onToggleShortcuts, onFocusSidebarSearch, onSignOut }: KeyboardShortcutHandlers): void {
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const isTypingInForm = !!target && (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable
      )
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        onTogglePalette()
        return
      }
      if (event.key === '?' && !isTypingInForm && !event.metaKey && !event.ctrlKey) {
        event.preventDefault()
        onToggleShortcuts()
        return
      }
      if (event.key === '/' && !isTypingInForm && !event.metaKey && !event.ctrlKey) {
        // Focus the sidebar search input via a stable data attribute so a
        // future CSS class rename doesn't silently no-op the shortcut.
        if (onFocusSidebarSearch()) {
          event.preventDefault()
        }
        return
      }
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'q') {
        event.preventDefault()
        onSignOut()
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onTogglePalette, onToggleShortcuts, onFocusSidebarSearch, onSignOut])
}
