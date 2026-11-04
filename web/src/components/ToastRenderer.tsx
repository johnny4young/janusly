/**
 * Global toast surface — reads from the Zustand store and renders any
 * queued toast as a clickable chip that dismisses on click. Mounted once
 * by `Layout.tsx` so any component can dispatch toasts via
 * `useWorkflowStore.getState().addToast({...})`.
 */

import { useEffect, useRef } from 'react'
import { useWorkflowStore } from '../store'
import { Button } from './ui/Button'

const toneClass: Record<string, string> = {
  success: 'toast-success',
  error: 'toast-error',
  info: 'toast-info',
}

/** The control that triggered an action toast is often gone (a removed row), so
 * orphaned keyboard focus lands here instead of the top of the page. */
function ToastActionButton({ label, onClick }: { label: string; onClick: () => void }) {
  const ref = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (document.activeElement === document.body) ref.current?.focus({ preventScroll: true })
  }, [])
  return <Button ref={ref} size="sm" onClick={onClick} data-testid="toast-action">{label}</Button>
}

/** Render the global toast stack (or nothing when empty). */
export function ToastRenderer() {
  const toasts = useWorkflowStore(state => state.toasts)
  const removeToast = useWorkflowStore(state => state.removeToast)

  if (!toasts.length) return null

  return (
    <div className="toast-stack" role="status" aria-live="polite">
      {toasts.map((toast) => toast.action ? (
        <div key={toast.id} className={`toast toast--action ${toneClass[toast.tone] ?? 'toast-info'}`}>
          <span>{toast.message}</span>
          <ToastActionButton
            label={toast.action.label}
            onClick={() => { removeToast(toast.id); toast.action?.onClick() }}
          />
        </div>
      ) : (
        <button
          key={toast.id}
          type="button"
          onClick={() => removeToast(toast.id)}
          className={`toast ${toneClass[toast.tone] ?? 'toast-info'}`}
        >
          {toast.message}
        </button>
      ))}
    </div>
  )
}
