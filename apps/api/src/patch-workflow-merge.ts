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
 * - For bounded array-of-pairs fields (`headers`, `input`), fold each
 *   item against the existing record before shallow-merging — non-null
 *   `value` sets/replaces; `null` removes the key; an empty or missing
 *   array is treated as a no-op so the field doesn't overwrite the
 *   existing config with an empty record.
 * - Reject no-op patches so Recovery doesn't present AI mode with no diff.
 */

import type { Workflow } from "@janusly/shared";

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
