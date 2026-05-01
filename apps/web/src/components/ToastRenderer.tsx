/**
 * Global toast surface — reads from the Zustand store and renders any
 * queued toast as a clickable chip that dismisses on click. Mounted once
 * by `Layout.tsx` so any component can dispatch toasts via
 * `useWorkflowStore.getState().addToast({...})`.
 */

import React from 'react'
import { useWorkflowStore } from '../store'

const toneClass: Record<string, string> = {
  success: 'toast-success',
  error: 'toast-error',
  info: 'toast-info',
}

/** Render the global toast stack (or nothing when empty). */
export function ToastRenderer() {
  const toasts = useWorkflowStore(state => state.toasts)
  const removeToast = useWorkflowStore(state => state.removeToast)

  if (!toasts.length) return null

  return (
    <div className="toast-stack" role="status" aria-live="polite">
      {toasts.map((toast) => (
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
