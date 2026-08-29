import { RollbackConfirmDialog } from '@janusly/web'
import { currentVersion, targetVersion } from './_fixtures'
import { Stage } from './_stage'

/**
 * The guard in front of a version rollback. It shows what changes between the
 * live version and the target *before* anything is written, because a rollback
 * publishes a new version rather than deleting the current one — the operator
 * needs to see which step configuration they are about to bring back.
 *
 * Here version 7 raised the invoice-fetch timeout to 30s; rolling back to 6
 * returns it to 10s, which is the change that caused the original failures.
 */
export function Confirming() {
  return (
    <Stage>
      <RollbackConfirmDialog
        workflowId="wf_invoice_recon"
        current={currentVersion}
        target={targetVersion}
        onClose={() => {}}
      />
    </Stage>
  )
}
