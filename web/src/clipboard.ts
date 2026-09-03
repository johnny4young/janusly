/**
 * Clipboard helpers with a legacy textarea fallback.
 *
 * Used by:
 * - `web/src/components/DeadLettersPanel.tsx`
 *
 * The fallback is intentionally synchronous and short-lived: the textarea is
 * mounted only for the browser's copy command and is always removed afterward.
 */

function copyWithTextarea(text: string): boolean {
  if (typeof document === 'undefined') return false

  let previousFocus: HTMLElement | null = null
  let textarea: HTMLTextAreaElement | null = null

  try {
    previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    textarea = document.createElement('textarea')
    textarea.value = text
    textarea.readOnly = true
    textarea.setAttribute('aria-hidden', 'true')
    textarea.style.position = 'fixed'
    textarea.style.inset = '0 auto auto -9999px'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.select()
    textarea.setSelectionRange(0, text.length)
    return typeof document.execCommand === 'function' && document.execCommand('copy')
  } catch {
    return false
  } finally {
    try {
      textarea?.remove()
    } catch {
      // Cleanup must not turn a safe fallback into an unhandled rejection.
    }
    try {
      if (previousFocus && document.contains(previousFocus)) previousFocus.focus()
    } catch {
      // A detached or browser-owned focus target can reject restoration.
    }
  }
}

/** Copy text through the Clipboard API, falling back to textarea selection. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // Permission or browser support can change at runtime; try the fallback.
  }

  return copyWithTextarea(text)
}
