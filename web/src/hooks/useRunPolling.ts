/**
 * Polling fallback for an active run's `/status` timeline. Owns `loadStatus`
 * (parse `/status`, merge nodes + events into the store, advance the events
 * cursor without rewinding "Load older events") and the 1500ms poll loop that
 * keeps the timeline fresh until the run reaches a terminal state. SSE
 * (`useRunEventStream`) is the live transport; this loop is the safety net and
 * loads the very first status snapshot. Extracted from `App`.
 *
 * Used by:
 * - `web/src/App.tsx`
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

import { useCallback, useEffect, useRef } from 'react'
import { contractApi } from '../api'
import { useWorkflowStore } from '../store'
import { useT } from '../i18n'
import { isRunRequestCurrent } from '../run-transition'
import { isTerminalRunStatus } from '@/lib/status'
import type { RunEvent, RunNode, RunSummary } from '../types'
import type { RunSummaryUpdateStarter } from './useBootstrapData'

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
  loadStatus: (id: string) => Promise<RunStatusLoadResult>
}

export type RunStatusLoadResult =
  | { discarded: true }
  | { discarded: false; status: RunResponse }

export type RunSummaryPatcher = (runId: string, patch: Partial<RunSummary>) => void

/**
 * Polls `/status?runId=` every 1500ms while `runId` is set, merging the result
 * into the store. `onTerminal` runs once the run reaches a terminal status
 * (the caller bumps platform version + refetches platform data); it may be
 * async and is awaited.
 */
export function useRunPolling(
  runId: string | null,
  onTerminal: () => void | Promise<void>,
  beginRunSummaryUpdate?: RunSummaryUpdateStarter,
): RunPolling {
  const { t } = useT()
  const setRunNodes = useWorkflowStore((s) => s.setRunNodes)
  const addEvents = useWorkflowStore((s) => s.addEvents)
  const setEventsPagination = useWorkflowStore((s) => s.setEventsPagination)
  const setStreamStatus = useWorkflowStore((s) => s.setStreamStatus)
  const addToast = useWorkflowStore((s) => s.addToast)
  const requestSequence = useRef(0)

  const loadStatus = useCallback(async (id: string): Promise<RunStatusLoadResult> => {
    const requestId = ++requestSequence.current
    const commitRunSummary = beginRunSummaryUpdate?.(id)
    const context = {
      runId: id,
      generation: useWorkflowStore.getState().runTransitionGeneration,
    }
    const isCurrentRequest = () => (
      requestId === requestSequence.current
      && isRunRequestCurrent(context, useWorkflowStore.getState())
    )
    let status: RunResponse
    try {
      status = await contractApi('GET /status', `/status?runId=${encodeURIComponent(id)}`, undefined) as unknown as RunResponse
    } catch (error) {
      if (!isCurrentRequest()) return { discarded: true }
      throw error
    }
    // A response for run A may arrive after the operator has opened run B.
    // The generation also prevents a same-id response from an older auth or
    // workflow owner from overwriting the current projection.
    if (!isCurrentRequest()) return { discarded: true }
    if (status.run) commitRunSummary?.(status.run)
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
    return { discarded: false, status }
  }, [addEvents, beginRunSummaryUpdate, setEventsPagination, setRunNodes])

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
    let inFlight = false
    let loadedInitialStatus = false
    setStreamStatus('connecting')

    const tick = async () => {
      if (stopped || inFlight) return
      // SSE is the live updater after the first status snapshot. Keep the
      // initial `/status` fetch even when SSE connects first; otherwise a
      // node.waiting event published before subscription can be missed and
      // `runNodes` never materializes.
      if (loadedInitialStatus && useWorkflowStore.getState().streamTransport === 'sse') return
      inFlight = true
      try {
        const result = await loadStatus(runId)
        if (closed) return
        if (result.discarded) return
        loadedInitialStatus = true
        setStreamStatus('connected')

        if (isTerminalRunStatus(result.status.run?.status)) {
          stopped = true
          window.clearInterval(interval)
          await onTerminal()
        }
      } catch (error) {
        if (!closed) {
          setStreamStatus('error')
          addToast(error instanceof Error ? error.message : t('toasts.runStatusFailed'), 'error')
        }
      } finally {
        inFlight = false
      }
    }

    void tick()
    const interval = window.setInterval(() => {
      if (!stopped) void tick()
    }, 1500)

    return () => {
      closed = true
      requestSequence.current += 1
      window.clearInterval(interval)
      setStreamStatus('closed')
    }
  }, [addToast, loadStatus, onTerminal, runId, setStreamStatus, t])

  return { loadStatus }
}
