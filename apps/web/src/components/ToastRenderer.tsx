import React from 'react'
import { useWorkflowStore } from '../store'

const toneClass: Record<string, string> = {
  success: 'border-emerald-200 bg-emerald-50 text-emerald-900',
  error: 'border-rose-200 bg-rose-50 text-rose-900',
  info: 'border-slate-200 bg-white text-slate-900',
}

export function ToastRenderer() {
  const { toasts, removeToast } = useWorkflowStore()

  if (!toasts.length) return null

  return (
    <div className="fixed bottom-4 right-4 z-50 flex w-80 flex-col gap-2">
      {toasts.map((toast) => (
        <button
          key={toast.id}
          onClick={() => removeToast(toast.id)}
          className={`rounded-xl border px-4 py-3 text-left text-sm shadow-lg transition hover:scale-[1.01] ${toneClass[toast.tone] ?? toneClass.info}`}
        >
          {toast.message}
        </button>
      ))}
    </div>
  )
}
