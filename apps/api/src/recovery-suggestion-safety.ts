/** Deterministic risk projection shared by AI patches and Recovery Playbooks. */

import { hasApprovalAncestor, isSensitiveAction } from "@janusly/engine/src/workflow-readiness";
import { WorkflowSchema } from "@janusly/shared";

export type RecoverySuggestionSafety = {
  writeSide: boolean;
  approvalRequired: boolean;
  approvalPresent: boolean;
};

/** Project the production-readiness sensitivity rule onto one candidate. */
export function recoverySuggestionSafety(workflow: unknown, nodeId: string): RecoverySuggestionSafety {
  const parsed = WorkflowSchema.safeParse(workflow);
  if (!parsed.success) {
    return { writeSide: true, approvalRequired: true, approvalPresent: false };
  }
  const node = parsed.data.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) {
    return { writeSide: true, approvalRequired: true, approvalPresent: false };
  }
  const writeSide = isSensitiveAction(node);
  const approvalPresent = !writeSide || hasApprovalAncestor(
    nodeId,
    parsed.data.edges,
    parsed.data.nodes,
    new Map(),
  );
  return { writeSide, approvalRequired: writeSide, approvalPresent };
}
