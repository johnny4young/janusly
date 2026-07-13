/**
 * Live-run streaming hook. Opens the `GET /runs/:runId/stream` SSE endpoint
 * via `fetch` + `ReadableStream` (native `EventSource` can't carry Janusly's
 * header-based auth), parses SSE frames, and merges run events into the store
 * as they arrive — so the run timeline updates in real time instead of every
 * 1.5s poll.
 *
 * Coordination with the polling fallback: this hook owns `streamTransport`.
 * - While SSE is healthy it sets `'sse'`; the App's polling effect is gated to
 *   pause whenever the transport is `'sse'`.
 * - On any SSE failure (offline, non-200, 429 over-cap, mid-stream error, or a
 *   proxy that buffers and never delivers a first byte) it sets `'polling'`,
 *   which resumes the poll loop, then retries SSE with capped backoff so a
 *   transient blip auto-recovers to live mode.
 * - On a terminal `run.status` it hands back to `'polling'` so the existing
 *   poll-loop terminal path (`bumpPlatformVersion` + platform refresh) runs in
 *   one place, then stops.
 *
 * Used by `apps/web/src/App.tsx` alongside the polling effect.
 *
 * Invariants:
 * - Initial timeline history comes from the regular `/status` fetch (the poll
 *   loop runs until SSE connects). This hook carries live signals and, on
 *   (re)connect, replays the gap by sending the newest known event id as
 *   `Last-Event-ID`. Overlap is harmless — the store dedupes by id.
 * - Never throws into render; all stream faults degrade to the polling
 *   fallback.
 */

import { useEffect } from 'react'

import { openRunEventStream } from '../api'
import { useWorkflowStore } from '../store'
import { isTerminalRunStatus } from '@janusly/shared/src/status'
import type { JsonObject, RunEvent, RunNode } from '../types'
import type { RunSummaryPatcher } from './useRunPolling'

/** Abort the connect attempt if no byte arrives — catches proxy buffering. */
const FIRST_BYTE_TIMEOUT_MS = 8_000
/** Reconnect backoff ceiling. */
const MAX_BACKOFF_MS = 8_000
/** Give up on SSE for this run after N consecutive failures (stay on polling). */
const MAX_CONSECUTIVE_FAILURES = 4

/** One field of a parsed SSE frame. */
type ParsedFrame = { id?: string; event?: string; data: string }

function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function waitingStateJson(payload: unknown): JsonObject {
  const record = isJsonObject(payload) ? payload : {}
  const metadata = isJsonObject(record.metadata) ? record.metadata : {}
  return { waiting: metadata }
}

function outputStateJson(payload: unknown): JsonObject {
  const record = isJsonObject(payload) ? payload : {}
  return { output: record.output ?? {} }
}

function skippedStateJson(payload: unknown): JsonObject {
  const record = isJsonObject(payload) ? payload : {}
  return { skipped: record.reason ?? record }
}

function errorJson(payload: unknown): JsonObject {
  const record = isJsonObject(payload) ? payload : {}
  const error = record.error
  if (isJsonObject(error)) return error
  if (typeof error === 'string') return { message: error }
  return {}
}

function runNodeFromEvent(event: RunEvent): RunNode | null {
  if (!event.nodeId) return null
  if (event.type === 'node.queued') return { nodeId: event.nodeId, status: 'queued' }
  if (event.type === 'node.running') return { nodeId: event.nodeId, status: 'running' }
  if (event.type === 'node.waiting') return { nodeId: event.nodeId, status: 'waiting', stateJson: waitingStateJson(event.payload) }
  if (event.type === 'node.succeeded') return { nodeId: event.nodeId, status: 'succeeded', stateJson: outputStateJson(event.payload) }
  if (event.type === 'node.resumed') return { nodeId: event.nodeId, status: 'succeeded', stateJson: outputStateJson(event.payload) }
  if (event.type === 'node.failed') return { nodeId: event.nodeId, status: 'failed', errorJson: errorJson(event.payload) }
  if (event.type === 'node.skipped') return { nodeId: event.nodeId, status: 'skipped', stateJson: skippedStateJson(event.payload) }
  return null
}

function parseFrame(raw: string): ParsedFrame | null {
  let id: string | undefined
  let event: string | undefined
  const dataLines: string[] = []
  for (const line of raw.split('\n')) {
    if (line === '' || line.startsWith(':')) continue // comment / blank (heartbeat)
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'id') id = value
    else if (field === 'event') event = value
    else if (field === 'data') dataLines.push(value)
  }
  if (dataLines.length === 0) return null
  return { id, event, data: dataLines.join('\n') }
}

export function useRunEventStream(runId: string | null, patchRunSummary?: RunSummaryPatcher): void {
  useEffect(() => {
    if (!runId) {
      useWorkflowStore.getState().setStreamTransport('idle')
      return
    }

    let stopped = false
    let failures = 0
    let controller: AbortController | null = null
    let retryTimer: ReturnType<typeof setTimeout> | null = null

    const store = useWorkflowStore
    // Newest event the client already has → `Last-Event-ID` cursor so the
    // server replays only the gap on (re)connect.
    const newestCursor = (): string | undefined => {
      const events = store.getState().events
      const newest = events[events.length - 1]
      return newest?.createdAt && newest.id ? `${newest.createdAt}|${newest.id}` : undefined
    }

    const fallbackToPolling = () => {
      if (stopped) return
      store.getState().setStreamTransport('polling')
    }

    const scheduleReconnect = () => {
      if (stopped || failures >= MAX_CONSECUTIVE_FAILURES) return
      const delay = Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** failures)
      retryTimer = setTimeout(() => { void connect() }, delay)
    }

    // Coalesce SSE frames into one store write per animation frame: a burst
    // of N frames becomes one addEvents + one render instead of N.
    let pendingEvents: RunEvent[] = []
    let pendingNodes: RunNode[] = []
    let flushHandle: number | null = null
    const flushPending = () => {
      flushHandle = null
      if (stopped) { pendingEvents = []; pendingNodes = []; return }
      if (pendingEvents.length > 0) {
        store.getState().addEvents(pendingEvents)
        pendingEvents = []
      }
      if (pendingNodes.length > 0) {
        const nodes = pendingNodes
        pendingNodes = []
        for (const node of nodes) store.getState().mergeRunNode(node)
      }
    }
    const scheduleFlush = () => {
      if (flushHandle === null) flushHandle = requestAnimationFrame(flushPending)
    }

    const handleData = (frame: ParsedFrame): 'terminal' | 'ok' => {
      let parsed: unknown
      try {
        parsed = JSON.parse(frame.data)
      } catch {
        return 'ok'
      }
      if (!parsed || typeof parsed !== 'object') return 'ok'
      const signal = parsed as { kind?: string; status?: string; id?: string; nodeId?: string | null; type?: string; payload?: unknown; createdAt?: string }
      if (signal.kind === 'run.status') {
        if (typeof signal.status === 'string') patchRunSummary?.(runId, { status: signal.status })
        return isTerminalRunStatus(signal.status) ? 'terminal' : 'ok'
      }
      if (signal.kind === 'event' && typeof signal.id === 'string' && typeof signal.type === 'string') {
        const event: RunEvent = {
          id: signal.id,
          nodeId: signal.nodeId ?? null,
          type: signal.type,
          payload: (signal.payload ?? null) as JsonObject | null,
          createdAt: signal.createdAt,
        }
        pendingEvents.push(event)
        const runNode = runNodeFromEvent(event)
        if (runNode) pendingNodes.push(runNode)
        scheduleFlush()
      }
      return 'ok'
    }

    const connect = async () => {
      if (stopped) return
      controller = new AbortController()
      let sawFirstByte = false
      const firstByteTimer = setTimeout(() => {
        if (!sawFirstByte) controller?.abort()
      }, FIRST_BYTE_TIMEOUT_MS)

      try {
        const res = await openRunEventStream(runId, { lastEventId: newestCursor(), signal: controller.signal })
        const reader = res.body!.getReader()
        const decoder = new TextDecoder()
        let buffer = ''

        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          if (!sawFirstByte) {
            sawFirstByte = true
            clearTimeout(firstByteTimer)
            failures = 0
            if (!stopped) {
              // Own both signals while live: transport drives the "Live" pill;
              // streamStatus keeps the existing operator-online indicator true.
              store.getState().setStreamTransport('sse')
              store.getState().setStreamStatus('connected')
            }
          }
          buffer += decoder.decode(value, { stream: true })
          let sep: number
          while ((sep = buffer.indexOf('\n\n')) !== -1) {
            const rawFrame = buffer.slice(0, sep)
            buffer = buffer.slice(sep + 2)
            const frame = parseFrame(rawFrame)
            if (!frame) continue
            if (handleData(frame) === 'terminal') {
              // Hand finalization (platform refresh) back to the poll loop.
              // Flip transport BEFORE marking stopped — `fallbackToPolling`
              // is guarded on `stopped`, so the order matters.
              clearTimeout(firstByteTimer)
              flushPending() // land any buffered events before handing off
              if (!stopped) store.getState().setStreamTransport('polling')
              stopped = true
              controller?.abort()
              return
            }
          }
        }
        // Stream ended without a terminal signal (server grace close or a
        // dropped connection) — reconnect from the last cursor.
        clearTimeout(firstByteTimer)
        if (!stopped) { failures += 1; fallbackToPolling(); scheduleReconnect() }
      } catch {
        clearTimeout(firstByteTimer)
        if (!stopped) { failures += 1; fallbackToPolling(); scheduleReconnect() }
      }
    }

    void connect()

    return () => {
      stopped = true
      if (retryTimer) clearTimeout(retryTimer)
      if (flushHandle !== null) cancelAnimationFrame(flushHandle)
      controller?.abort()
      useWorkflowStore.getState().setStreamTransport('idle')
    }
  }, [patchRunSummary, runId])
}
