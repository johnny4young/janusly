import { RunStreamChip } from '@janusly/web'
import { Seed } from './_stage'

/**
 * Connection state for the active run's live stream. Everything comes from the
 * store: `runId`, `streamTransport`, and the timestamp of the newest run event.
 * The only prop, `showIdle`, decides whether the chip stays mounted when
 * nothing is streaming — Operations pins it so the toolbar slot does not jump,
 * compact surfaces let it disappear.
 *
 * The chip deliberately says two things at once. `Live` (green, SSE) or
 * `Polling` (amber, the 1.5s fallback loop) reports that the channel is open;
 * the age beside it reports when something last happened on it — so a stalled
 * run reads as stale rather than falsely fresh.
 *
 * Three store values are required together: without `runId` the chip renders
 * the neutral idle pill no matter what the transport says.
 *
 * Store-gated, so one story — the polling variant flips the same
 * `streamTransport` key and cannot share a card with this one; see `_stage.tsx`.
 */

// Relative to render time so the age reads as a live "4m ago" rather than a
// date months in the past.
const lastEventAt = new Date(Date.now() - 4 * 60 * 1000).toISOString()

export function LiveWithAge() {
  return (
    <Seed
      patch={{
        runId: 'run_9f21c4',
        streamStatus: 'connected',
        streamTransport: 'sse',
        events: [{ id: 'ev_8841', nodeId: 'fetch_invoice', type: 'node.attempt', createdAt: lastEventAt }],
      }}
    >
      <RunStreamChip showIdle />
    </Seed>
  )
}
