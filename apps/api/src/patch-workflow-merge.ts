/**
 * Pure merge helper for `/ai/patch-workflow`.
 *
 * Used by:
 *   - `apps/api/src/index.ts` — composes the route's full workflow response
 *     from the LLM's config-only patch envelope.
 *   - `apps/api/src/patch-workflow-merge.test.ts` — pins no-op guards.
 *
 * Invariants:
 * - Patch exactly the failing node by id.
 * - Strip nullable-envelope sentinel values before merging.
 * - Reject no-op patches so Recovery doesn't present AI mode with no diff.
 */

import type { Workflow } from "@janusly/shared";

/** Remove `null` sentinel fields emitted by provider-strict nullable envelopes. */
export function stripNullPatchValues(patchedConfig: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(patchedConfig).filter(([, value]) => value !== null),
  );
}

/** Compose the full workflow suggestion from a config-only patch envelope. */
export function applyConfigPatchToWorkflow(
  workflow: Workflow,
  failedNodeId: string,
  rawPatchedConfig: Record<string, unknown>,
): Workflow {
  const hasFailedNode = workflow.nodes.some((node) => node.id === failedNodeId);
  if (!hasFailedNode) {
    throw new Error(`Original workflow does not contain failing node id "${failedNodeId}"`);
  }

  const patchedConfig = stripNullPatchValues(rawPatchedConfig);
  if (Object.keys(patchedConfig).length === 0) {
    throw new Error("AI patch did not include any config changes");
  }

  return {
    ...workflow,
    nodes: workflow.nodes.map((node) =>
      node.id === failedNodeId
        ? { ...node, config: { ...(node.config ?? {}), ...patchedConfig } }
        : node,
    ),
  };
}
