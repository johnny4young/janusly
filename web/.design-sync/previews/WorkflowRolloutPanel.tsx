import { WorkflowRolloutPanel } from '@janusly/web'
import { Seed } from './_stage'

/**
 * Canary rollout control for one workflow: it splits traffic between a
 * baseline and a candidate version and holds promotion until the candidate
 * clears both gates — a minimum sample size and a minimum success rate.
 *
 * The panel hides until a **saved** workflow is selected, so the preview seeds
 * that. Shown mid-rollout at 25% traffic with the candidate ahead of baseline
 * but still short of the 40-run sample gate.
 *
 * `readOnly` is prop-driven, so both permission states share one store seed.
 */
const active = { currentWorkflowId: 'wf_invoice_recon', currentWorkflowSaved: true }

/** An editor sees the promote and roll-back controls. */
export function Editable() {
  return (
    <Seed patch={active}>
      <WorkflowRolloutPanel />
    </Seed>
  )
}

/** A viewer sees the same evidence with the controls withheld. */
export function ReadOnly() {
  return (
    <Seed patch={active}>
      <WorkflowRolloutPanel readOnly />
    </Seed>
  )
}
