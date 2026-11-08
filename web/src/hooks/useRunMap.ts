/**
 * Live run map: one shared feed per run, whatever number of views read it.
 *
 * The feed refetches the map shortly after the run projection changes (stream
 * frames or the polling fallback), and on a slow tick so elapsed time and the
 * stuck signal advance while nothing streams. The tick stops once the run is
 * terminal. A failed read keeps the previous map within the same identity.
 * An organization or user change retires all feeds and cached snapshots.
 */

import { useCallback, useSyncExternalStore } from 'react'

import { contractApi } from '../api'
import { isGetRunsRunIdMapResponse } from '../lib/api-guards/operations/GetRunsRunIdMap'
import { isTerminalRunStatus } from '../lib/status'
import type { RunMapSnapshot } from '../run-map'
import { useWorkflowStore } from '../store'

export const RUN_MAP_SETTLE_MS = 400
export const RUN_MAP_TICK_MS = 15_000

type Feed = {
  runId: string
  listeners: Set<() => void>
  snapshot: RunMapSnapshot | null
  inFlight: boolean
  again: boolean
  settle?: ReturnType<typeof setTimeout>
  tick?: ReturnType<typeof setInterval>
  controller: AbortController
  unwatch: () => void
}

const feeds = new Map<string, Feed>()
let lastSnapshot: RunMapSnapshot | null = null

function identityKey(): string {
  const { userId, orgId } = useWorkflowStore.getState()
  return JSON.stringify([userId, orgId])
}

// Cached maps contain tenant facts and viewer-specific decisions. Retire
// them even when no view is mounted, before another identity can read them.
useWorkflowStore.subscribe((state, previous) => {
  if (state.userId === previous.userId && state.orgId === previous.orgId) return
  lastSnapshot = null
  const retired = [...feeds.values()]
  for (const feed of retired) closeFeed(feed)
  for (const feed of retired) {
    for (const listener of feed.listeners) listener()
  }
})

function syncTick(feed: Feed) {
  const finished = feed.snapshot !== null && isTerminalRunStatus(feed.snapshot.map.run.status)
  if (finished && feed.tick !== undefined) {
    clearInterval(feed.tick)
    feed.tick = undefined
  } else if (!finished && feed.tick === undefined) {
    feed.tick = setInterval(() => load(feed), RUN_MAP_TICK_MS)
  }
}

function load(feed: Feed) {
  if (feed.inFlight) {
    feed.again = true
    return
  }
  feed.inFlight = true
  feed.again = false
  // The signal also opts out of api()'s short GET dedup, so a refetch is fresh.
  contractApi('GET /runs/{runId}/map', `/v1/runs/${encodeURIComponent(feed.runId)}/map`, undefined, {
    signal: feed.controller.signal,
    guard: isGetRunsRunIdMapResponse,
  }).then((map) => {
    if (feeds.get(feed.runId) !== feed) return
    feed.snapshot = { runId: feed.runId, map, receivedAt: Date.now() }
    lastSnapshot = feed.snapshot
    syncTick(feed)
    for (const listener of feed.listeners) listener()
  }, () => undefined).finally(() => {
    feed.inFlight = false
    if (feed.again && feeds.get(feed.runId) === feed) load(feed)
  })
}

function settle(feed: Feed) {
  clearTimeout(feed.settle)
  feed.settle = setTimeout(() => load(feed), RUN_MAP_SETTLE_MS)
}

function openFeed(runId: string): Feed {
  const feed: Feed = {
    runId,
    listeners: new Set(),
    snapshot: lastSnapshot?.runId === runId ? lastSnapshot : null,
    inFlight: false,
    again: false,
    controller: new AbortController(),
    unwatch: () => undefined,
  }
  feed.unwatch = useWorkflowStore.subscribe((state, previous) => {
    if (state.runId !== runId) return
    if (state.events !== previous.events || state.runNodes !== previous.runNodes) settle(feed)
  })
  feeds.set(runId, feed)
  load(feed)
  syncTick(feed)
  return feed
}

function closeFeed(feed: Feed) {
  if (feeds.get(feed.runId) === feed) feeds.delete(feed.runId)
  feed.unwatch()
  feed.controller.abort()
  clearTimeout(feed.settle)
  clearInterval(feed.tick)
}

export function subscribeRunMap(runId: string, listener: () => void): () => void {
  const feed = feeds.get(runId) ?? openFeed(runId)
  feed.listeners.add(listener)
  return () => {
    feed.listeners.delete(listener)
    if (feed.listeners.size === 0) closeFeed(feed)
  }
}

export function readRunMap(runId: string): RunMapSnapshot | null {
  return feeds.get(runId)?.snapshot ?? (lastSnapshot?.runId === runId ? lastSnapshot : null)
}

/** Refetch now, after an action changed the run. */
export function refreshRunMap(runId: string) {
  const feed = feeds.get(runId)
  if (feed) load(feed)
}

const noop = () => undefined

export function useRunMap(runId: string | null | undefined): RunMapSnapshot | null {
  const identity = useWorkflowStore(state => JSON.stringify([state.userId, state.orgId]))
  const subscribe = useCallback(
    (listener: () => void) => (runId && identity === identityKey() ? subscribeRunMap(runId, listener) : noop),
    [identity, runId],
  )
  const read = useCallback(() => (runId && identity === identityKey() ? readRunMap(runId) : null), [identity, runId])
  return useSyncExternalStore(subscribe, read, read)
}
