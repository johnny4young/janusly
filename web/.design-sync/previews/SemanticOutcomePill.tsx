import { SemanticOutcomePill } from '@janusly/web'

/**
 * The four semantic outcomes a run can end in. Tone is derived from the
 * status inside the component (`data-tone`), so the status prop is the only
 * axis a caller controls.
 */

export function SemanticFailure() {
  return <SemanticOutcomePill status="semantic_violation" />
}

export function OutcomeBlocked() {
  return <SemanticOutcomePill status="semantic_quarantined" />
}

export function OutcomeRecovered() {
  return <SemanticOutcomePill status="semantic_recovered" />
}

export function AcceptedOutcome() {
  return <SemanticOutcomePill status="semantic_accepted_loss" />
}

/** How the pills read against each other in a run list. */
export function AllOutcomes() {
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
      <SemanticOutcomePill status="semantic_recovered" />
      <SemanticOutcomePill status="semantic_accepted_loss" />
      <SemanticOutcomePill status="semantic_violation" />
      <SemanticOutcomePill status="semantic_quarantined" />
    </div>
  )
}
