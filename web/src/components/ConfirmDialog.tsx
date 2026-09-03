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
import { useDialogFocusTrap } from '../hooks/useDialogFocusTrap'
import { Button } from './ui/Button'

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
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const confirmButtonRef = useRef<HTMLButtonElement | null>(null)
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null)
  useDialogFocusTrap(dialogRef, {
    active: options !== null,
    // A danger confirm must not let a stray Enter fire the destructive
    // action: focus lands on Cancel so acknowledgment is deliberate.
    initialFocus: options?.tone === 'danger' ? cancelButtonRef : confirmButtonRef,
  })

  const confirm = useCallback<ConfirmFn>((next) => {
    // Only one modal can own the shared provider at a time. A re-entrant call
    // (for example, a double-triggered destructive action) must not replace the
    // active resolver/options because that would leave the first caller's
    // Promise hanging. Treat overlapping requests as "not confirmed".
    if (resolveRef.current) return Promise.resolve(false)
    return new Promise<boolean>((resolve) => {
      resolveRef.current = resolve
      setOptions(next)
    })
  }, [])

  const close = useCallback((ok: boolean) => {
    resolveRef.current?.(ok)
    resolveRef.current = null
    setOptions(null)
  }, [])

  // If the provider unmounts while a confirm is open (test cleanup, route-level
  // teardown, or a future conditional mount), resolve the pending caller instead
  // of leaving an await forever suspended.
  useEffect(() => {
    return () => {
      resolveRef.current?.(false)
      resolveRef.current = null
    }
  }, [])

  // Escape remains dialog-specific; the shared hook owns initial focus, the
  // Tab trap, Strict Mode replay safety, and trigger restoration.
  useEffect(() => {
    if (!options) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        close(false)
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
                <h2 id="confirm-dialog-title">{options.title ?? (t('confirmDialog.title'))}</h2>
                <p id="confirm-dialog-body" className="helper-text">{options.body}</p>
              </div>
            </header>
            <footer className="run-input-dialog__footer">
              <Button ref={cancelButtonRef} variant="secondary" onClick={() => close(false)} data-testid="confirm-dialog-cancel">
                {options.cancelLabel ?? (t('common.cancel'))}
              </Button>
              <Button
                ref={confirmButtonRef}
                variant={options.tone === 'danger' ? 'danger' : 'primary'}
                onClick={() => close(true)}
                data-testid="confirm-dialog-confirm"
              >
                {options.confirmLabel ?? (t('confirmDialog.confirm'))}
              </Button>
            </footer>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  )
}
