import { WorkflowSloPanel } from '@janusly/web'

/**
 * Service-level objectives for a workflow. `workflowId` is optional — omitted,
 * the panel takes the current workflow from the store, which is how the
 * operations column mounts it. That fallback gets no cell of its own: with a
 * workflow selected it renders exactly what the explicit binding renders, and
 * with none it renders nothing at all.
 */

/** Bound to an explicit workflow, editable. */
export function Editable() {
  return <WorkflowSloPanel workflowId="wf_invoice_recon" readOnly={false} />
}

/** A viewer, with the SLO thresholds read-only. */
export function ReadOnly() {
  return <WorkflowSloPanel workflowId="wf_invoice_recon" readOnly />
}
