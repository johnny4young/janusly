/**
 * Shared control-plane mutation lifecycle.
 *
 * Owns the repeated request/error-toast boundary while callers retain their
 * domain-specific success effects (status reloads, platform invalidation,
 * navigation, and recovery coordination). The configurable toast timing is
 * deliberate: existing App flows do not all announce success at the same
 * point, and this hook must preserve that observable ordering.
 *
 * Used by: `apps/web/src/App.tsx` platform mutation handlers.
 */

import { useCallback } from 'react'

import { useWorkflowStore } from '../store'

type ToastTone = 'success' | 'error' | 'info'

export type PlatformMutationToast = {
  message: string
  tone?: ToastTone
}

export type PlatformMutationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: unknown }

export type PlatformMutationOptions<T> = {
  request: () =>
    Promise<T>
  failureMessage: string
  successToast?: PlatformMutationToast | ((value: T) => PlatformMutationToast | null)
  successToastTiming?: 'before-effect' | 'after-effect'
  onSuccess?: (value: T) => void | Promise<void>
}

/**
 * Return one stable generic mutation runner.
 *
 * Errors thrown by either the request or the caller-owned success effect use
 * the same error path, matching the former App-level `try/catch` boundaries.
 */
export function usePlatformMutation() {
  const addToast = useWorkflowStore((state) => state.addToast)

  return useCallback(async function runPlatformMutation<T>(
    options: PlatformMutationOptions<T>,
  ): Promise<PlatformMutationResult<T>> {
    try {
      const value = await options.request()
      const toast = typeof options.successToast === 'function'
        ? options.successToast(value)
        : options.successToast

      if (toast && options.successToastTiming === 'before-effect') {
        addToast(toast.message, toast.tone)
      }

      await options.onSuccess?.(value)

      if (toast && options.successToastTiming !== 'before-effect') {
        addToast(toast.message, toast.tone)
      }

      return { ok: true, value }
    } catch (error) {
      addToast(error instanceof Error ? error.message : options.failureMessage, 'error')
      return { ok: false, error }
    }
  }, [addToast])
}
