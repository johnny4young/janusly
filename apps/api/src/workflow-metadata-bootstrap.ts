/**
 * Boot-time registration of the `workflow_metadata.severityDefault`
 * resolver into the engine's DI seam. Called once at api startup AND
 * once at worker startup so DLQ inserts on either process produce
 * recovery_items with the correct per-workflow severity.
 *
 * Mirrors `apps/api/src/index.ts` registering `setRecoveryItemCreator`
 * at boot. The resolver reads `workflow_metadata` via the production
 * data repo; failures degrade silently to null inside the DI seam so
 * the engine falls back to its hardcoded severity default.
 */

import { setRecoveryItemSeverityDefault } from "@janusly/data/src/recovery-item-severity-default";
import { getWorkflowMetadata } from "@janusly/data/src/workflowMetadataRepo";

/** Wire the production severity-default resolver. Idempotent. */
export function registerWorkflowMetadataSeverityResolver(): void {
  setRecoveryItemSeverityDefault(async (orgId, workflowId) => {
    const metadata = await getWorkflowMetadata(orgId, workflowId);
    return metadata?.severityDefault ?? null;
  });
}
