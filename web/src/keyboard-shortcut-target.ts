/**
 * Shared editable-target guard for keyboard shortcut surfaces.
 *
 * Used by:
 * - `web/src/hooks/useKeyboardShortcuts.ts`
 * - `web/src/components/DeadLettersPanel.tsx`
 *
 * Keeping this pure guard separate avoids coupling lazy operational panels to
 * the global React hook and preserves the boot chunk boundary.
 */

/** Return true when a shortcut event originates in an editable control. */
export function isKeyboardShortcutTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.tagName === 'INPUT'
    || target.tagName === 'TEXTAREA'
    || target.tagName === 'SELECT'
    || target.isContentEditable
    || target.contentEditable === 'true'
    || target.getAttribute('contenteditable') === 'true'
}
