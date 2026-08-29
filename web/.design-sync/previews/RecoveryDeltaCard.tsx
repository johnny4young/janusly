import { RecoveryDeltaCard } from '@janusly/web'
import { preSaveBeforeSnapshot } from './_fixtures'

/**
 * Did the fix work? The card compares workflow health from before the fix was
 * saved against the window since, and — the part that actually settles the
 * question — counts how many times the *same* failure signature has recurred
 * against the new version.
 *
 * `preSaveBeforeSnapshot` is captured at save time rather than recomputed, so
 * the "before" side cannot drift as the window moves. Health comes from
 * `GET /workflows/health/delta` on mount.
 */
export function AfterAFix() {
  return (
    <RecoveryDeltaCard
      workflowId="wf_invoice_recon"
      afterVersion={7}
      priorFailureSignature="HTTP 503 from billing.acme.com"
      preSaveBeforeSnapshot={preSaveBeforeSnapshot}
    />
  )
}
