/**
 * Connection-status pill for the active run's live stream. Reads
 * `streamTransport` from the store (owned by `useRunEventStream`) and renders:
 * - green "Live" when the SSE stream is connected,
 * - amber "Polling" when SSE is unavailable and the 1.5s poll loop is the
 *   fallback updater,
 * - nothing when there's no active run.
 *
 * Mirrors `RateLimiterStatusChip` in `OperationsPage` (same dot + chip
 * structure). Self-contained — reads the store directly so it can mount in any
 * header without prop drilling. Mounted in `RunsPanel` and the Operations
 * header.
 */

import { useT } from '../i18n'
import { useWorkflowStore } from '../store'

export function RunStreamChip() {
  const { t } = useT()
  const runId = useWorkflowStore((state) => state.runId)
  const streamTransport = useWorkflowStore((state) => state.streamTransport)

  if (!runId || streamTransport === 'idle') return null

  const isLive = streamTransport === 'sse'
  return (
    <span
      className={`we-run-stream-chip ${isLive ? 'we-run-stream-chip--live' : 'we-run-stream-chip--fallback'}`}
      role="status"
      aria-label={t('runStream.label') as string}
    >
      <span className="we-run-stream-chip__dot" aria-hidden="true" />
      <span>{isLive ? t('runStream.live') : t('runStream.polling')}</span>
    </span>
  )
}
