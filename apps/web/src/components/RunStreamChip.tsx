/**
 * Connection-status pill for the active run's live stream. Reads
 * `streamTransport` from the store (owned by `useRunEventStream`) and renders:
 * - green "Live" when the SSE stream is connected,
 * - amber "Polling" when SSE is unavailable and the 1.5s poll loop is the
 *   fallback updater,
 * - nothing when there's no active run.
 *
 * It also shows an "as of" age for the most recent run event so a stalled run
 * reads as stale (e.g. "Live · 4m ago") rather than falsely fresh — the
 * transport pill says the channel is open, the age says when something last
 * happened on it.
 *
 * Mirrors `RateLimiterStatusChip` in `OperationsPage` (same dot + chip
 * structure). Self-contained — reads the store directly so it can mount in any
 * header without prop drilling. Mounted in `RunsPanel` and the Operations
 * header.
 */

import { useEffect, useState } from 'react'
import { useT } from '../i18n'
import { useWorkflowStore } from '../store'
import { humanizeAge } from './recovery-center/helpers'

/** How often the relative "as of" age re-computes while a run is active. */
const AS_OF_TICK_MS = 15_000

export function RunStreamChip() {
  const { t } = useT()
  const runId = useWorkflowStore((state) => state.runId)
  const streamTransport = useWorkflowStore((state) => state.streamTransport)
  const lastEventAt = useWorkflowStore((state) => state.events.at(-1)?.createdAt)

  // Re-render on a slow tick so the relative age advances even when no new
  // events arrive (a stalled run still visibly ages). Scheduled only while the
  // chip is visible, so an idle/non-streaming run keeps no background timer.
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    if (!runId || streamTransport === 'idle') return
    const id = window.setInterval(() => setNowMs(Date.now()), AS_OF_TICK_MS)
    return () => window.clearInterval(id)
  }, [runId, streamTransport])

  if (!runId || streamTransport === 'idle') return null

  const isLive = streamTransport === 'sse'
  const stateLabel = isLive ? t('runStream.live') : t('runStream.polling')
  const age = humanizeAge(lastEventAt, nowMs)
  const ariaLabel = age ? `${t('runStream.label')}: ${stateLabel} · ${age}` : `${t('runStream.label')}: ${stateLabel}`

  return (
    <span
      className={`we-run-stream-chip ${isLive ? 'we-run-stream-chip--live' : 'we-run-stream-chip--fallback'}`}
      role="status"
      aria-label={ariaLabel}
    >
      <span className="we-run-stream-chip__dot" aria-hidden="true" />
      <span>{stateLabel}</span>
      {age ? <span className="we-run-stream-chip__age">· {age}</span> : null}
    </span>
  )
}
