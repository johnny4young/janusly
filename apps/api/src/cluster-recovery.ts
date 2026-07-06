/**
 * Cluster-recovery helpers — the small bit of glue that bridges the
 * `data` layer's failure-sample collection with the `engine` layer's
 * signature normalizer for the bulk DLQ recovery flow.
 *
 * The repos in `@janusly/data` intentionally don't import from
 * `@janusly/engine`, so the wiring lives here in `apps/api` (which
 * already depends on both). Two responsibilities:
 *
 *   1. `findClusterMembers(orgId, signature, windowDays, limit)` —
 *      enumerate DLQ rows in the window whose normalized error
 *      signature matches the claimed cluster signature. Used by
 *      `GET /dlq/cluster-members` to seed the recovery dialog.
 *
 *   2. `recheckSignature(item, claimedSignature)` — re-normalize one
 *      DLQ row's error and assert it still matches the cluster
 *      signature. Used by `POST /dlq/cluster-apply` per row to defend
 *      against stale member lists (a row replayed via another path
 *      between fetch and apply could no longer match).
 *
 * Multi-tenant scope is enforced by the route layer (it passes
 * `auth.orgId` into `findClusterMembers` and only loads `getDeadLetter`
 * rows that already passed the org-scoped query).
 */

import {
  queryFailureSamples,
} from "@janusly/data";
import { normalizeErrorSignature } from "@janusly/engine/src/error-signature";
import type { Workflow, WorkflowNode } from "@janusly/shared";

/** Default member-list cap; matches the bulk-apply request bound. */
export const CLUSTER_MEMBERS_DEFAULT_LIMIT = 100;
/** Hard upper bound on the member list. The bulk-apply route enforces
 *  the same cap so a single request can't replay more than this. */
export const CLUSTER_MEMBERS_MAX_LIMIT = 100;
/** How many failure-source rows to scan per request before filtering by
 *  signature. 500 mirrors `failureClusterRepo`'s sample cap and keeps
 *  the latency bounded even when one signature dominates. */
const SAMPLE_SCAN_LIMIT = 500;

export type FindClusterMembersResult = {
  /** DLQ row ids whose normalized signature matches `signature`. Capped at `limit`. */
  deadLetterIds: string[];
  /** Total matching rows in the scanned window before the cap was applied. */
  total: number;
  /** True when `total > limit` — the dialog should warn the operator. */
  capped: boolean;
};

/**
 * Enumerate DLQ rows whose normalized error signature matches
 * `signature`. Only `dead_letter`-source samples are returned;
 * `failed_run_node`-source samples don't have a DLQ id to replay
 * against.
 *
 * The window + scan limit defend against unbounded scans: at most
 * `SAMPLE_SCAN_LIMIT` failure rows are normalized per request.
 */
export async function findClusterMembers(
  orgId: string,
  signature: string,
  windowDays: number,
  limit: number,
): Promise<FindClusterMembersResult> {
  const cappedLimit = Math.max(1, Math.min(limit, CLUSTER_MEMBERS_MAX_LIMIT));
  const samples = await queryFailureSamples(orgId, windowDays, SAMPLE_SCAN_LIMIT);

  const matched: string[] = [];
  let total = 0;
  for (const sample of samples) {
    if (sample.source !== "dead_letter") continue;
    if (sample.status !== "open") continue;
    const result = normalizeErrorSignature(sample.errorJson, {
      nodeType: sample.nodeType,
      toolName: sample.toolName,
    });
    if (result.signature !== signature) continue;
    total += 1;
    if (matched.length < cappedLimit) {
      matched.push(sample.id);
    }
  }

  return {
    deadLetterIds: matched,
    total,
    capped: total > cappedLimit,
  };
}

/** Minimal shape of the persisted DLQ row that `recheckSignature` needs. */
type DeadLetterRowForSignature = {
  errorJson: unknown;
  nodeJson: unknown;
};

/**
 * Re-normalize a DLQ row's error and assert the result still matches
 * `claimedSignature`. Defends the bulk-apply route against a stale
 * member list: if the operator approved 100 ids but one was replayed
 * (or otherwise mutated) between fetch and apply, that row is rejected
 * server-side instead of silently included.
 */
export function recheckSignature(item: DeadLetterRowForSignature, claimedSignature: string): boolean {
  const node = item.nodeJson as { type?: unknown; config?: { tool?: unknown } } | null;
  const nodeType = typeof node?.type === "string" ? node.type : "node";
  const toolName = typeof node?.config?.tool === "string" ? node.config.tool : undefined;
  const result = normalizeErrorSignature(item.errorJson, { nodeType, toolName });
  return result.signature === claimedSignature;
}

/**
 * Decide which workflow (+ failing node) a cluster member replays against when
 * an applied fix is present. A cluster is grouped by failure SIGNATURE and can
 * span workflows, so the representative fix applies ONLY to members of the SAME
 * workflow (`sanitizedFix.id === memberWorkflow.id`) whose failing node id
 * survives the patch — every other member re-runs its own snapshot. Returns
 * `fixNode` (the patched failing node from the fix) when the fix applies, else
 * `null` (the caller replays the member's own workflow + snapshot node).
 */
export function pickClusterReplayWorkflow(
  memberWorkflow: Workflow,
  failingNodeId: string,
  sanitizedFix: Workflow | null,
): { workflow: Workflow; fixNode: WorkflowNode | null } {
  if (sanitizedFix && memberWorkflow.id && sanitizedFix.id === memberWorkflow.id) {
    const fixNode = sanitizedFix.nodes.find((n) => n.id === failingNodeId);
    if (fixNode) return { workflow: sanitizedFix, fixNode };
  }
  return { workflow: memberWorkflow, fixNode: null };
}
