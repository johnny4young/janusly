import { WorkflowStatusPageCard } from '@janusly/web'
import { Seed } from './_stage'

/**
 * Publishes a workflow's public status page and shows the path once it is
 * live. It hides itself entirely until a workflow is selected *and* saved —
 * an unsaved draft has no stable URL to publish — so the preview seeds both.
 *
 * Store-gated, so one story — see `_stage.tsx`.
 */
export function Published() {
  return (
    <Seed patch={{ currentWorkflowId: 'wf_invoice_recon', currentWorkflowSaved: true }}>
      <WorkflowStatusPageCard />
    </Seed>
  )
}
