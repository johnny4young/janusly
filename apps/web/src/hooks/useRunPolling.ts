/**
 * Polling fallback for an active run's `/status` timeline. Owns `loadStatus`
 * (parse `/status`, merge nodes + events into the store, advance the events
 * cursor without rewinding "Load older events") and the 1500ms poll loop that
 * keeps the timeline fresh until the run reaches a terminal state. SSE
 * (`useRunEventStream`) is the live transport; this loop is the safety net and
 * loads the very first status snapshot. Extracted from `App`.
 *
 * Used by:
 * - `apps/web/src/App.tsx`
 *
 * Invariants:
 * - The tick is a no-op while `streamTransport === 'sse'` (read imperatively
 *   from the store, NEVER an effect dep) and resumes the moment SSE drops to
 *   `'polling'`.
 * - Events merge via `addEvents` — DON'T replace events wholesale or you
 *   re-introduce the timeline-clobber bug.
 * - On terminal status the `onTerminal` callback fires (the caller bumps
 *   `platformVersion` so independent panels re-fetch — cross-panel reactivity).
 * - Effect deps intentionally exclude `streamTransport` so a transport flip
 *   never tears the interval down and races the SSE hook's `streamStatus` write.
 */

import { useCallback, useEffect } from 'react'
import { api } from '../api'
import { useWorkflowStore } from '../store'
import { useT } from '../i18n'
import { isTerminalRunStatus } from '@janusly/shared/src/status'
import type { RunEvent, RunNode, RunSummary } from '../types'

type RunResponse = {
  run?: RunSummary
  nodes?: RunNode[]
  events?: RunEvent[]
  eventsCursor?: string | null
  eventsHasMore?: boolean
}

/** The poll machinery surface returned to the shell. `loadStatus` is shared
 *  with the shell's run-action handlers (approve / resume / replay / cancel),
 *  which fetch a fresh snapshot after mutating a run. */
export type RunPolling = {
  loadStatus: (id: string) => Promise<RunResponse>
}

/**
 * Polls `/status?runId=` every 1500ms while `runId` is set, merging the result
 * into the store. `onTerminal` runs once the run reaches a terminal status
 * (the caller bumps platform version + refetches platform data); it may be
 * async and is awaited.
 */
export function useRunPolling(runId: string | null, onTerminal: () => void | Promise<void>): RunPolling {
  const { t } = useT()
  const setRunNodes = useWorkflowStore((s) => s.setRunNodes)
  const addEvents = useWorkflowStore((s) => s.addEvents)
  const setEventsPagination = useWorkflowStore((s) => s.setEventsPagination)
  const setStreamStatus = useWorkflowStore((s) => s.setStreamStatus)
  const addToast = useWorkflowStore((s) => s.addToast)

  const loadStatus = useCallback(async (id: string): Promise<RunResponse> => {
    const status = await api(`/status?runId=${encodeURIComponent(id)}`) as RunResponse
    setRunNodes(status.nodes ?? [])
    const statusEvents = status.events ?? []
    addEvents(statusEvents)
    // /status always describes the latest page. Once the user has loaded older
    // pages, preserving the existing cursor prevents polling from rewinding the
    // "Load older events" button back to the first page of history.
    if (typeof status.eventsHasMore === 'boolean') {
      const state = useWorkflowStore.getState()
      const hasLoadedBeyondLatestPage = state.events.length > statusEvents.length
      if (!status.eventsHasMore) {
        setEventsPagination(null, false)
      } else if (!state.eventsCursor && !hasLoadedBeyondLatestPage) {
        setEventsPagination(status.eventsCursor ?? null, true)
      }
    }
    return status
  }, [addEvents, setEventsPagination, setRunNodes])

  // Polling fallback. The original 1.5s `/status` loop loads the initial
  // timeline and stays as the safety net. Its tick is a no-op while SSE is the
  // live transport (a cheap in-memory check, no network) and resumes the moment
  // SSE drops back to `'polling'`. Deps intentionally exclude `streamTransport`
  // so a transport flip never tears the interval down (which would otherwise
  // race the SSE hook's `streamStatus` write).
  useEffect(() => {
    if (!runId) return

    let closed = false
    let stopped = false
    let loadedInitialStatus = false
    setStreamStatus('connecting')

    const tick = async () => {
      // SSE is the live updater after the first status snapshot. Keep the
      // initial `/status` fetch even when SSE connects first; otherwise a
      // node.waiting event published before subscription can be missed and
      // `runNodes` never materializes.
      if (loadedInitialStatus && useWorkflowStore.getState().streamTransport === 'sse') return
      try {
        const status = await loadStatus(runId)
        loadedInitialStatus = true
        if (closed) return
        setStreamStatus('connected')

        if (isTerminalRunStatus(status.run?.status)) {
          stopped = true
          window.clearInterval(interval)
          await onTerminal()
        }
      } catch (error) {
        if (!closed) {
          setStreamStatus('error')
          addToast(error instanceof Error ? error.message : t('toasts.runStatusFailed'), 'error')
        }
      }
    }

    void tick()
    const interval = window.setInterval(() => {
      if (!stopped) void tick()
    }, 1500)

    return () => {
      closed = true
      window.clearInterval(interval)
      setStreamStatus('closed')
    }
  }, [addToast, loadStatus, onTerminal, runId, setStreamStatus, t])

  return { loadStatus }
}
