import { useEffect, useRef, type ReactNode } from 'react'
import { EvidencePanel } from '@janusly/web'

/**
 * What the AI actually looked at before proposing a recovery. Each row names
 * its `kind` and `sourceRef` so an operator can trace the claim back, and the
 * optional `weight` (0–1) renders as a relevance bar.
 *
 * The panel is a `<details>` that ships closed — correct in the product, where
 * it sits under a decision the operator is reading first. These cells open it
 * so the card shows the evidence rather than just the summary line.
 */
function Opened({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    ref.current?.querySelectorAll('details').forEach((d) => {
      d.open = true
    })
  }, [])
  return <div ref={ref}>{children}</div>
}

/** The full mix of evidence kinds behind one suggestion. */
export function MixedEvidence() {
  return (
    <Opened>
      <EvidencePanel
        evidence={[
          {
            kind: 'recent_error',
            sourceRef: 'run_9f21c4 · step fetch_invoice',
            snippet: 'HTTP 503 from billing.acme.com after 30000ms — upstream did not respond.',
            weight: 0.94,
          },
          {
            kind: 'signature_rule',
            sourceRef: 'sig_5xx_upstream_timeout',
            snippet: 'Repeated 5xx within a maintenance window resolves by raising the timeout.',
            weight: 0.81,
          },
          {
            kind: 'runbook_excerpt',
            sourceRef: 'docs/runbooks/billing.md#timeouts',
            label: 'Runbook',
            snippet: 'The billing provider publishes a nightly window between 02:00 and 02:15 UTC.',
            weight: 0.67,
          },
          {
            kind: 'recovery_feedback',
            sourceRef: 'ri_8c31d0',
            label: 'Past feedback',
            snippet: 'An operator applied the same timeout change here and marked it effective.',
            weight: 0.55,
          },
        ]}
      />
    </Opened>
  )
}

/** A thin case — one weak signal, nothing corroborating it. */
export function SingleWeakSignal() {
  return (
    <Opened>
      <EvidencePanel
        evidence={[
          {
            kind: 'memory_entry',
            sourceRef: 'mem_2c90fa',
            snippet: 'This workflow was edited three days ago; no failure was recorded before that.',
            weight: 0.22,
          },
        ]}
      />
    </Opened>
  )
}

// Note: `evidence={[]}` is supported and renders nothing at all, so it is
// documented here rather than shown as an empty cell.
