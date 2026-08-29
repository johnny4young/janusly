import { WorkflowRecoveryQualification } from '@janusly/web'

/**
 * The recovery gate on a canary rollout. Before a candidate version can be
 * promoted it has to show it recovers at least as well as the baseline — a
 * candidate that is faster but fails to recover is not an improvement.
 *
 * It reports its verdict upward through `onGateChange` so the rollout panel can
 * hold promotion on it, and `readOnly` withholds the controls from a viewer
 * while keeping the evidence visible.
 */

/** An editor can act on the gate. */
export function Editable() {
  return (
    <WorkflowRecoveryQualification
      workflowId="wf_invoice_recon"
      baselineVersionId="wfv_0006"
      candidateVersionId="wfv_0007"
      readOnly={false}
      onGateChange={() => {}}
    />
  )
}

/** A viewer sees the same verdict without the controls. */
export function ReadOnly() {
  return (
    <WorkflowRecoveryQualification
      workflowId="wf_invoice_recon"
      baselineVersionId="wfv_0006"
      candidateVersionId="wfv_0007"
      readOnly
      onGateChange={() => {}}
    />
  )
}
