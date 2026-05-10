/**
 * `parallel_fork` and `join` node types — the DAG fan-out / fan-in primitive
 * pair. Together they let an operator declare "branch out into N independent
 * tracks here, gather the results back together there" with named branches,
 * instead of relying on naked node-id references in downstream templates.
 *
 * The two executors live in one module because they form a conceptual pair
 * and share a small amount of label-validation. The runtime semantics that
 * make fork / join work — fan-out via multiple outgoing edges, fan-in waiting
 * for all predecessors before queuing, atomic single-claim of the join — are
 * already provided by the existing engine. Both executors here are thin:
 *
 *   - `parallelForkExecutor` is a passthrough that validates the declared
 *     branches and echoes them as `output.branches`. The actual fan-out is
 *     just having multiple outgoing edges from this node in the workflow,
 *     which `enqueueReadyNodes` handles transparently.
 *
 *   - `joinExecutor` reads `ctx.context[sourceNodeId].output` for each
 *     declared source and assembles `output.branches` keyed by branch label.
 *     The "wait for all branches to terminate" property is free — the
 *     runtime's ALL-AND fan-in readiness check (every incoming edge
 *     predecessor must be `succeeded` or `skipped`) keeps the join from
 *     queuing until every branch is done.
 *
 * Failure semantics: when any branch fails terminally, that node ends up in
 * `failed` status, which means the join's predecessor set is no longer all
 * `succeeded|skipped`. The join therefore never queues; the run rolls up to
 * `failed`. This matches the AC: "one branch failing fails the whole join".
 *
 * Used by:
 *   - `node-registry.ts` registers `parallel_fork: parallelForkExecutor` and
 *     `join: joinExecutor`.
 *
 * Invariants:
 *   - `parallel_fork.config.branches` must declare 2-10 unique labels (≤ 64
 *     chars each). Sub-2 isn't a fork; over-10 hits both UI usability and
 *     compiled-grammar concerns if AI generation ever learns this type.
 *   - `join.config.sources` is a `Record<branchLabel, predecessorNodeId>`.
 *     The executor reads predecessor output via `ctx.context[predId].output`
 *     so the assembled `branches` map is keyed by intent (label), not by
 *     implementation detail (node id).
 */

import type { NodeExecutor } from "./node-registry";

const MIN_BRANCHES = 2;
const MAX_BRANCHES = 10;
const MAX_LABEL_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 280;

/**
 * Validated branch declaration on a `parallel_fork` node. The optional
 * description surfaces in the inspector and (eventually) in AI prompts so a
 * downstream consumer reading the workflow knows what the branch was meant
 * to compute.
 */
export type ParallelForkBranch = {
  label: string;
  description?: string;
};

/**
 * Translate a `parallel_fork` node's `config.branches` into a validated array
 * of branch declarations. Throws with a descriptive message on invalid input
 * so the runtime surfaces the failure on `node.failed` rather than silently
 * proceeding with a malformed fan-out.
 */
export function resolveParallelForkBranches(config: unknown): ParallelForkBranch[] {
  if (!isPlainObject(config)) {
    throw new Error("parallel_fork.config must be an object with a `branches` array");
  }
  const raw = config.branches;
  if (!Array.isArray(raw)) {
    throw new Error("parallel_fork.config.branches must be an array of { label, description? } entries");
  }
  if (raw.length < MIN_BRANCHES) {
    throw new Error(`parallel_fork.config.branches must declare at least ${MIN_BRANCHES} branches (got ${raw.length})`);
  }
  if (raw.length > MAX_BRANCHES) {
    throw new Error(`parallel_fork.config.branches supports at most ${MAX_BRANCHES} branches (got ${raw.length})`);
  }

  const branches: ParallelForkBranch[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of raw.entries()) {
    if (!isPlainObject(entry)) {
      throw new Error(`parallel_fork.config.branches[${index}] must be an object with a \`label\` field`);
    }
    const label = entry.label;
    if (typeof label !== "string" || label.trim().length === 0) {
      throw new Error(`parallel_fork.config.branches[${index}].label is required and must be a non-empty string`);
    }
    if (label.length > MAX_LABEL_LENGTH) {
      throw new Error(`parallel_fork.config.branches[${index}].label must be ≤ ${MAX_LABEL_LENGTH} chars (got ${label.length})`);
    }
    if (seen.has(label)) {
      throw new Error(`parallel_fork.config.branches has duplicate label "${label}"`);
    }
    seen.add(label);

    let description: string | undefined;
    if (entry.description !== undefined) {
      if (typeof entry.description !== "string") {
        throw new Error(`parallel_fork.config.branches[${index}].description must be a string when provided`);
      }
      if (entry.description.length > MAX_DESCRIPTION_LENGTH) {
        throw new Error(`parallel_fork.config.branches[${index}].description must be ≤ ${MAX_DESCRIPTION_LENGTH} chars`);
      }
      description = entry.description;
    }

    branches.push(description !== undefined ? { label, description } : { label });
  }
  return branches;
}

/**
 * Validated source map on a `join` node — `Record<branchLabel,
 * predecessorNodeId>`. The executor reads `ctx.context[predecessorId].output`
 * for each entry to build the labelled output.
 */
export type JoinSources = Record<string, string>;

/**
 * Translate a `join` node's `config.sources` into a validated label →
 * predecessor-id map. Throws with a descriptive message on invalid input so
 * the runtime surfaces the failure on `node.failed`.
 */
export function resolveJoinSources(config: unknown): JoinSources {
  if (!isPlainObject(config)) {
    throw new Error("join.config must be an object with a `sources` map");
  }
  const raw = config.sources;
  if (!isPlainObject(raw)) {
    throw new Error("join.config.sources must be an object mapping branch labels to predecessor node ids");
  }
  const entries = Object.entries(raw);
  if (entries.length < MIN_BRANCHES) {
    throw new Error(`join.config.sources must declare at least ${MIN_BRANCHES} branches (got ${entries.length})`);
  }
  if (entries.length > MAX_BRANCHES) {
    throw new Error(`join.config.sources supports at most ${MAX_BRANCHES} branches (got ${entries.length})`);
  }

  const sources: JoinSources = {};
  const seenPredecessorIds = new Set<string>();
  for (const [label, value] of entries) {
    if (label.trim().length === 0) {
      throw new Error("join.config.sources contains an empty branch label");
    }
    if (label.length > MAX_LABEL_LENGTH) {
      throw new Error(`join.config.sources label "${label}" must be ≤ ${MAX_LABEL_LENGTH} chars`);
    }
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error(`join.config.sources["${label}"] must be a non-empty predecessor node id`);
    }
    // Reject duplicate predecessor ids — symmetric to the fork's
    // duplicate-label guard. The most common cause is a copy-paste of one
    // entry that the operator forgot to update; surfacing it loudly here
    // beats silently emitting duplicated branch data.
    if (seenPredecessorIds.has(value)) {
      throw new Error(`join.config.sources references predecessor "${value}" more than once`);
    }
    seenPredecessorIds.add(value);
    sources[label] = value;
  }
  return sources;
}

/**
 * Executor for the `parallel_fork` node — passthrough that validates the
 * declared branches and echoes them. The actual fan-out happens via the
 * workflow's outgoing edges from this node.
 */
export const parallelForkExecutor: NodeExecutor = async (ctx) => {
  const branches = resolveParallelForkBranches(ctx.config);
  return {
    status: "completed",
    output: { branches },
  };
};

/**
 * Executor for the `join` node — reads each declared source's output from
 * the per-run context and assembles them into `output.branches` keyed by
 * branch label. Predecessors that haven't produced an `output` (a defensive
 * shape — the runtime's fan-in readiness check should prevent this in
 * practice) surface as `undefined` rather than throwing.
 */
export const joinExecutor: NodeExecutor = async (ctx) => {
  const sources = resolveJoinSources(ctx.config);
  const branches: Record<string, unknown> = {};
  for (const [label, predecessorId] of Object.entries(sources)) {
    const predecessor = ctx.context?.[predecessorId];
    branches[label] = isPlainObject(predecessor) ? (predecessor as { output?: unknown }).output : undefined;
  }
  return {
    status: "completed",
    output: { branches },
  };
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
