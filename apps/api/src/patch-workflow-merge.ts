/**
 * Pure merge helper for `/ai/patch-workflow`.
 *
 * Used by:
 *   - `apps/api/src/routes/ai-routes.ts` — composes the route's full workflow response
 *     from the LLM's config-only patch envelope.
 *   - `apps/api/src/patch-workflow-merge.test.ts` — pins no-op guards.
 *
 * Invariants:
 * - Patch exactly the failing node by id.
 * - Strip nullable-envelope sentinel values before merging.
 * - For bounded array-of-pairs fields (`headers`, `input`), fold each
 *   item against the existing record before shallow-merging — non-null
 *   `value` sets/replaces; `null` removes the key; an empty or missing
 *   array is treated as a no-op so the field doesn't overwrite the
 *   existing config with an empty record.
 * - Reject no-op patches so Recovery doesn't present AI mode with no diff.
 */

import type { Workflow, WorkflowEdge, WorkflowNode } from "@janusly/shared";

/** A `{ name, value }` pair as the LLM emits it for the `headers` / `input` array patch shape. */
type PairItem = { name: string; value: string | null };

/**
 * Per-node-type whitelist of fields whose patched value is the
 * `Array<{ name, value }>` shape rather than a value to assign verbatim.
 * Scoped by node type so the generic envelope doesn't silently coerce a
 * structurally-different field (e.g. `subworkflow.config.input` is a
 * forwarded input object, not a flat string-keyed map — it must NOT
 * flow through the pair-array fold).
 */
const PAIR_ARRAY_FIELDS_BY_NODE_TYPE: Readonly<Record<string, readonly string[]>> = {
  http: ["headers"],
  tool: ["input"],
  transform: ["mapping"],
  loop: ["mapping"],
};

/** Remove `null` sentinel fields emitted by provider-strict nullable envelopes. */
export function stripNullPatchValues(patchedConfig: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(patchedConfig).filter(([, value]) => value !== null),
  );
}

/**
 * Fold an `Array<{ name, value }>` patch against an existing flat record.
 * Non-null values set/replace; null values remove the key. Missing keys
 * preserve whatever is already in `existing`.
 */
function foldPairArrayWithExisting(
  existing: Record<string, unknown>,
  incoming: PairItem[],
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...existing };
  for (const { name, value } of incoming) {
    if (value === null) {
      delete merged[name];
    } else {
      merged[name] = value;
    }
  }
  return merged;
}

function flatRecordsEqual(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => Object.is(left[key], right[key]));
}

/**
 * Coerce an arbitrary `node.config[field]` to a flat record. HTTP headers
 * must stay string-only for the executor; tool input can preserve existing
 * non-string fields because tool schemas decide which value types are valid.
 */
function coerceExistingPairRecord(value: unknown, options: { stringOnly: boolean }): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (options.stringOnly && typeof v !== "string") continue;
    out[key] = v;
  }
  return out;
}

/** True if a value parses as a non-empty `Array<{ name, value: string|null }>`. */
function isNonEmptyPairArray(value: unknown): value is PairItem[] {
  if (!Array.isArray(value) || value.length === 0) return false;
  return value.every((item) => {
    if (!item || typeof item !== "object") return false;
    const candidate = item as { name?: unknown; value?: unknown };
    return typeof candidate.name === "string" && (typeof candidate.value === "string" || candidate.value === null);
  });
}

/** Compose the full workflow suggestion from a config-only patch envelope. */
export function applyConfigPatchToWorkflow(
  workflow: Workflow,
  failedNodeId: string,
  rawPatchedConfig: Record<string, unknown>,
): Workflow {
  const failingNode = workflow.nodes.find((node) => node.id === failedNodeId);
  if (!failingNode) {
    throw new Error(`Original workflow does not contain failing node id "${failedNodeId}"`);
  }

  const patchedConfig = stripNullPatchValues(rawPatchedConfig);

  // Fold array-of-pair fields against the failing node's existing record,
  // but ONLY for the per-node-type fields that the resilience envelopes
  // actually emit in the array-of-pairs shape. Other node types (e.g.
  // `subworkflow.config.input`, which is a forwarded input object, not a
  // flat string-keyed map) must NOT be coerced — the LLM's patch flows
  // through the generic envelope verbatim. Empty arrays drop out as no-ops.
  const failingNodeType = (failingNode as { type?: unknown }).type;
  const pairFields = typeof failingNodeType === "string" ? PAIR_ARRAY_FIELDS_BY_NODE_TYPE[failingNodeType] ?? [] : [];
  for (const field of pairFields) {
    const incoming = patchedConfig[field];
    if (!isNonEmptyPairArray(incoming)) {
      // Either missing, null (already stripped), or empty array. Drop so
      // the existing record passes through untouched.
      delete patchedConfig[field];
      continue;
    }
    const existingRecord = coerceExistingPairRecord(
      (failingNode.config as Record<string, unknown> | undefined)?.[field],
      { stringOnly: failingNodeType === "http" && field === "headers" },
    );
    const mergedRecord = foldPairArrayWithExisting(existingRecord, incoming);
    if (flatRecordsEqual(existingRecord, mergedRecord)) {
      delete patchedConfig[field];
      continue;
    }
    patchedConfig[field] = mergedRecord;
  }

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

/**
 * Structural patch input — emits node-graph changes instead of a
 * single-node config patch. v1 only wires `insert_approval_upstream`;
 * future structural fixes add an `action` literal and a new branch
 * in `applyStructuralPatchToWorkflow`.
 */
export type StructuralPatchInput =
  | {
      action: "insert_approval_upstream";
      approvalNodeId: string;
      approvalMessage: string;
      insertBeforeNodeId: string;
    };

/**
 * Compose the full workflow suggestion from a structural patch
 * envelope. For `insert_approval_upstream`: validate the target node
 * exists, reject collisions with existing node ids, insert a new
 * `approval` node, and rewrite every edge whose `to` is the target so
 * it routes through the new approval. The new approval's only outgoing
 * edge points at the original target — operators reading the diff see
 * a single new node inserted in front of the failing one.
 *
 * Pure function — same shape as `applyConfigPatchToWorkflow`. Throws
 * descriptively on a collision or missing target so the route's
 * per-suggestion validation drops the offending suggestion.
 */
export function applyStructuralPatchToWorkflow(
  workflow: Workflow,
  patch: StructuralPatchInput,
  expectedInsertBeforeNodeId?: string,
): Workflow {
  if (patch.action !== "insert_approval_upstream") {
    // Exhaustiveness guard. v1 only wires the one action; the schema
    // pins it via z.literal so this branch is defensive.
    throw new Error(`Unknown structural patch action: ${(patch as { action?: string }).action ?? "<missing>"}`);
  }

  const { approvalNodeId, approvalMessage, insertBeforeNodeId } = patch;
  if (expectedInsertBeforeNodeId && insertBeforeNodeId !== expectedInsertBeforeNodeId) {
    throw new Error(`Structural patch target "${insertBeforeNodeId}" does not match failing node "${expectedInsertBeforeNodeId}"`);
  }

  const target = workflow.nodes.find((node) => node.id === insertBeforeNodeId);
  if (!target) {
    throw new Error(`Structural patch target "${insertBeforeNodeId}" does not exist in the workflow`);
  }

  if (workflow.nodes.some((node) => node.id === approvalNodeId)) {
    throw new Error(`Structural patch approval node id "${approvalNodeId}" collides with an existing node`);
  }

  const newApprovalNode: WorkflowNode = {
    id: approvalNodeId,
    type: "approval",
    config: { message: approvalMessage },
  };

  // Rewire every edge `to === insertBeforeNodeId` so the upstream
  // predecessors now flow into the approval first. Edges with no
  // matching `to` pass through untouched. Outgoing edges from the
  // target also pass through untouched — the approval is inserted
  // strictly between predecessors and the target.
  const rewiredEdges: WorkflowEdge[] = workflow.edges.map((edge) => {
    if (edge.to === insertBeforeNodeId) {
      return { ...edge, to: approvalNodeId };
    }
    return edge;
  });

  // Add the approval -> target edge. No `condition` so the approval
  // gates the target unconditionally; the engine's approval-waiting
  // semantics handle the human-gate flow.
  rewiredEdges.push({ from: approvalNodeId, to: insertBeforeNodeId });

  return {
    ...workflow,
    nodes: [...workflow.nodes, newApprovalNode],
    edges: rewiredEdges,
  };
}
