import { WorkflowDiffView } from '@janusly/web'

/**
 * Side-by-side comparison of two workflow versions — what version history
 * shows, and what a recovery patch is reviewed through before it is applied.
 * `aiPatchRationale` renders below the diff when the change came from a
 * suggestion rather than a human edit.
 */

const before = {
  dslVersion: '1.0' as const,
  id: 'wf_invoice_recon',
  name: 'Invoice reconciliation',
  nodes: [
    { id: 'fetch_invoice', type: 'http', label: 'Fetch invoice', config: { url: 'https://api.acme.com/v1/invoices/{{ inputs.invoiceId }}', method: 'GET', timeoutMs: 30000 } },
    { id: 'compare', type: 'agent', label: 'Compare to PO', config: { model: 'claude-sonnet-5' } },
    { id: 'notify', type: 'tool', label: 'Notify billing', config: { tool: 'slack.post' } },
  ],
  edges: [
    { from: 'fetch_invoice', to: 'compare' },
    { from: 'compare', to: 'notify' },
  ],
}

/** One step's timeout raised — the shape a recovery patch usually takes. */
export function TimeoutRaised() {
  return (
    <WorkflowDiffView
      beforeLabel="v7 — currently live"
      afterLabel="v8 — proposed"
      before={before}
      after={{
        ...before,
        nodes: before.nodes.map((n) =>
          n.id === 'fetch_invoice'
            ? { ...n, config: { ...n.config, timeoutMs: 90000 } }
            : n,
        ),
      }}
      aiPatchRationale="This signature failed 14 times in 7 days, always inside the provider's 02:00–02:15 UTC maintenance window. Raising the timeout from 30s to 90s covers the observed recovery time without weakening the failure signal."
    />
  )
}

/** A structural change: a new step and a rewired edge. */
export function StepAdded() {
  return (
    <WorkflowDiffView
      beforeLabel="v7"
      afterLabel="v8"
      before={before}
      after={{
        ...before,
        nodes: [
          ...before.nodes.slice(0, 2),
          { id: 'approve', type: 'approval', label: 'Human approval', config: { assignee: 'billing-oncall@acme.com', onTimeout: 'fail' } },
          ...before.nodes.slice(2),
        ],
        edges: [
          { from: 'fetch_invoice', to: 'compare' },
          { from: 'compare', to: 'approve' },
          { from: 'approve', to: 'notify' },
        ],
      }}
    />
  )
}

/** Both sides identical — the no-change state still has to read clearly. */
export function NoChanges() {
  return <WorkflowDiffView beforeLabel="v7" afterLabel="v7" before={before} after={before} />
}
