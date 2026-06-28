/**
 * App-wide confirm dialog — a focus-managed, localized replacement for the
 * native `window.confirm()`. Mount `<ConfirmProvider>` once near the app root;
 * call `useConfirm()` in any component to get an async `confirm(options)` that
 * resolves `true` (confirmed) or `false` (cancelled / escaped / dismissed).
 *
 * Why not native confirm(): it can't be styled (breaks dark mode), isn't
 * localized, and drops focus to the document on dismiss. This modal traps Tab
 * within itself, restores focus to the trigger on close, closes on Escape /
 * backdrop click, and carries the `alertdialog` ARIA roles.
 *
 * Used by the destructive-action handlers across the settings panels
 * (connections / permissions / SCIM / alerts / upstream-health).
 */

import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { useT } from '../i18n'

/**
 * One confirm() invocation's copy + styling. `body` is the already-localized
 * question; `title` / `confirmLabel` / `cancelLabel` fall back to generic
 * localized defaults. `tone: 'danger'` styles the confirm button as
 * destructive.
 */
export type ConfirmOptions = {
  title?: string
  body: string
  confirmLabel?: string
  cancelLabel?: string
  tone?: 'default' | 'danger'
}

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>

const ConfirmContext = createContext<ConfirmFn | null>(null)

/**
 * Returns the app-wide confirm function. The app mounts `<ConfirmProvider>` at
 * the root, so in production this is always the styled modal. Absent a provider
 * (an isolated component test, or a misconfiguration) it degrades to the native
 * `window.confirm` rather than throwing — keeping callers working everywhere.
 */
export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext)
  return ctx ?? (async (options) => (typeof window !== 'undefined' ? window.confirm(options.body) : false))
}

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const { t } = useT()
  const [options, setOptions] = useState<ConfirmOptions | null>(null)
  const resolveRef = useRef<((ok: boolean) => void) | null>(null)
  const triggerRef = useRef<HTMLElement | null>(null)
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const confirmButtonRef = useRef<HTMLButtonElement | null>(null)

  const confirm = useCallback<ConfirmFn>((next) => {
    // Remember the element that opened the dialog so focus can return to it.
    triggerRef.current = (document.activeElement as HTMLElement | null) ?? null
    return new Promise<boolean>((resolve) => {
      resolveRef.current = resolve
      setOptions(next)
    })
  }, [])

  const close = useCallback((ok: boolean) => {
    resolveRef.current?.(ok)
    resolveRef.current = null
    setOptions(null)
    const trigger = triggerRef.current
    triggerRef.current = null
    // Restore focus after the dialog unmounts.
    if (trigger) requestAnimationFrame(() => trigger.focus())
  }, [])

  // Focus the confirm button when the dialog opens.
  useEffect(() => {
    if (options) confirmButtonRef.current?.focus()
  }, [options])

  // Escape closes; Tab is trapped between the dialog's buttons.
  useEffect(() => {
    if (!options) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        close(false)
        return
      }
      if (event.key === 'Tab') {
        const root = dialogRef.current
        if (!root) return
        const focusable = Array.from(root.querySelectorAll<HTMLElement>('button:not([disabled])'))
        if (focusable.length === 0) return
        const first = focusable[0]!
        const last = focusable[focusable.length - 1]!
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault()
          last.focus()
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault()
          first.focus()
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [options, close])

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {options && (
        <div className="run-input-backdrop" onClick={() => close(false)}>
          <div
            ref={dialogRef}
            className="run-input-dialog run-input-dialog--confirm"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="confirm-dialog-title"
            aria-describedby="confirm-dialog-body"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="run-input-dialog__header">
              <span className="run-input-dialog__icon" aria-hidden="true">
                <AlertTriangle size={18} />
              </span>
              <div className="run-input-dialog__heading">
                <h2 id="confirm-dialog-title">{options.title ?? (t('confirmDialog.title') as string)}</h2>
                <p id="confirm-dialog-body" className="helper-text">{options.body}</p>
              </div>
            </header>
            <footer className="run-input-dialog__footer">
              <button type="button" className="command-button" onClick={() => close(false)} data-testid="confirm-dialog-cancel">
                {options.cancelLabel ?? (t('common.cancel') as string)}
              </button>
              <button
                ref={confirmButtonRef}
                type="button"
                className={`command-button ${options.tone === 'danger' ? 'command-button-danger' : 'command-button-primary'}`}
                onClick={() => close(true)}
                data-testid="confirm-dialog-confirm"
              >
                {options.confirmLabel ?? (t('confirmDialog.confirm') as string)}
              </button>
            </footer>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  )
}
