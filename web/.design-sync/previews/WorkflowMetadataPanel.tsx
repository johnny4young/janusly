import { WorkflowMetadataPanel } from '@janusly/web'

/**
 * The workflow's identity and ownership fields — name, description, tags, and
 * the metadata that lets the workspace find it later.
 *
 * `readOnly` withholds editing for a viewer, but the panel keeps the same
 * layout and the same values either way, so a single story is shown instead of
 * a pair that measures as identical.
 */
export function Editable() {
  return <WorkflowMetadataPanel workflowId="wf_invoice_recon" />
}
