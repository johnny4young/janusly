import { ReasoningPanel } from '@janusly/web'

/**
 * The run's event trace — what the engine did, step by step. Events arrive
 * newest-last; `eventsHasMore` plus `onLoadOlderEvents` drive the paging
 * affordance, so a long run does not have to be held in memory at once.
 */

const events = [
  {
    id: 'ev_01',
    nodeId: 'fetch_invoice',
    type: 'node_started',
    createdAt: '2026-08-26T02:00:00.000Z',
    payload: { url: 'https://api.acme.com/v1/invoices/inv_10482', method: 'GET' },
  },
  {
    id: 'ev_02',
    nodeId: 'fetch_invoice',
    type: 'node_failed',
    createdAt: '2026-08-26T02:00:30.000Z',
    payload: { status: 503, message: 'Upstream did not respond within 30000ms' },
  },
  {
    id: 'ev_03',
    nodeId: 'fetch_invoice',
    type: 'node_retried',
    createdAt: '2026-08-26T02:00:32.000Z',
    payload: { attempt: 2, backoffMs: 2000 },
  },
  {
    id: 'ev_04',
    nodeId: 'fetch_invoice',
    type: 'node_succeeded',
    createdAt: '2026-08-26T02:00:41.000Z',
    payload: { status: 200, lineItems: 12 },
  },
  {
    id: 'ev_05',
    nodeId: 'compare',
    type: 'node_started',
    createdAt: '2026-08-26T02:00:41.500Z',
    payload: { model: 'claude-sonnet-5' },
  },
  {
    id: 'ev_06',
    nodeId: 'compare',
    type: 'node_succeeded',
    createdAt: '2026-08-26T02:00:44.000Z',
    payload: { discrepancies: 1, line: 7 },
  },
]

/** A run that failed, retried, and recovered — the most informative trace. */
export function RetryThenRecovery() {
  return <ReasoningPanel events={events} activeRunId="run_9f21c4" />
}

/** A long run, with older events still to page in. */
export function WithOlderEvents() {
  return (
    <ReasoningPanel
      events={events}
      activeRunId="run_9f21c4"
      eventsHasMore
      onLoadOlderEvents={() => {}}
    />
  )
}

/** No events yet — nothing has been recorded for this run. */
export function NoEvents() {
  return <ReasoningPanel events={[]} />
}
