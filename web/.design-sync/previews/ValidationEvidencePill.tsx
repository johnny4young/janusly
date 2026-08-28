import { ValidationEvidencePill } from '@janusly/web'

/**
 * How much evidence stands behind a validation result, from a purely static
 * check up to a live canary. The `level` is the whole axis — it selects both
 * the label and the tone.
 */

/** Static analysis only — no execution happened. */
export function Static() {
  return <ValidationEvidencePill level="static" />
}

/** The workflow ran, but every write was suppressed. */
export function WritesSkipped() {
  return <ValidationEvidencePill level="writes_skipped" />
}

/** Providers were simulated rather than called. */
export function ProviderSimulated() {
  return <ValidationEvidencePill level="provider_simulated" />
}

/** The strongest evidence: a live canary against the real provider. */
export function LiveCanary() {
  return <ValidationEvidencePill level="live_canary" />
}

/** The escalation ladder, weakest to strongest. */
export function EvidenceLadder() {
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
      <ValidationEvidencePill level="static" />
      <ValidationEvidencePill level="writes_skipped" />
      <ValidationEvidencePill level="provider_simulated" />
      <ValidationEvidencePill level="live_canary" />
    </div>
  )
}
