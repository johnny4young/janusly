/**
 * Single entry point per BullMQ workflow job. Resolves the run's `orgId`,
 * pulls the per-run `context`, runs the executor for `node.type`, and
 * applies secret/env redaction to successful outputs, waiting metadata, and
 * thrown errors before returning to the runtime.
 *
 * Used by `worker.ts` (every BullMQ job's handler) and indirectly by
 * `core/runtime.ts` through the `NodeExecutorRegistry` adapter.
 *
 * Invariants:
 * - A missing run row is fatal — don't synthesise a default `orgId` (the
 *   multi-tenant scope on `usage_events` would break).
 * - Secret/env values are stripped before they leave this function so they
 *   never reach `run_nodes.state_json`, `run_events.payload`, or DLQ
 *   `error_json`.
 */

import { nodeRegistry, isWriteSideNode } from "./node-registry";
import { NODE_CONFIG_SCHEMAS } from "./node-configs";
import { getNodeTimeoutMs, NodeTimeoutError, withTimeout } from "./core/timeout";
import { getRunContext, getRunMetadata } from "./persistence";
import { redactError, redactValues, renderTemplateWithRedactions } from "./template";
import type { ExecuteNodeInput, NodeExecutionResult } from "./core/types";
import type { NodeType } from "@janusly/shared/src/workflow";

/**
 * Run one node end-to-end: look up org/context, render templates with
 * secret/env tracking, dispatch to the executor, and redact resolved values
 * before returning or rethrowing.
 */
export async function executeNode(input: Pick<ExecuteNodeInput, "runId" | "node">): Promise<NodeExecutionResult> {
  const { node, runId } = input;

  const executor = nodeRegistry[node.type];

  if (!executor) {
    throw new Error(`No executor for node type: ${node.type}`);
  }

  // Resolve org scope + workflow id once per node execution so
  // executors can attribute usage telemetry without duplicating the
  // lookup. A missing run row is fatal — silently writing usage rows
  // with a synthetic "default" orgId would pollute multi-tenant cost
  // accounting (see the multi-tenant invariant in AGENTS.md). Same
  // shape as the missing-executor throw above. `getRunMetadata`
  // joins through `workflow_versions` so executors get the workflow
  // id for the billing breakdown surface as well.
  const meta = await getRunMetadata(runId);
  if (!meta) {
    throw new Error(`Cannot execute node: run ${runId} not found`);
  }
  const orgId = meta.orgId;
  const workflowId = meta.workflowId;

  // Sandbox/validation runs (`runs.replayMode === "validation"`) carry a
  // dryRun flag through every node execution so write-side actions
  // (HTTP non-safe methods, tools flagged `writeSide`) can be skipped
  // without committing external state. Reuses the single `getRunMetadata`
  // row above — no second per-node `runs` lookup.
  const dryRun = meta.replayMode === "validation";

  const context = await getRunContext(runId);

  // Merge the run's start/trigger input as `context.input` — the contract the
  // triggers docstring promises and `{{context.input.*}}` templates resolve.
  // Done HERE (not inside getRunContext) so the readiness scans'
  // `statusesOnly` variant stays input-free, and reusing the single
  // `getRunMetadata` row above costs no extra per-node query. Guarded so a
  // legacy workflow whose node id is literally "input" keeps its slot
  // (validation reserves the id for new saves — `node_id_reserved`).
  if (context.input === undefined) {
    context.input = meta.input ?? {};
  }

  const scope = {
    context,
    inputs: node.config
  };

  const { rendered: resolvedConfig, redactedValues } = renderTemplateWithRedactions(node.config, scope);

  let result: Awaited<ReturnType<typeof executor>>;
  try {
    // Inner refinement: validate the (post-template) config against the
    // per-node-type schema before invoking the executor. Catches typos /
    // type mismatches the API-boundary WorkflowSchema's opaque
    // `z.record(z.string(), z.unknown())` lets through. A parse failure
    // throws here and rides the same catch below so the error message
    // flows through `redactError` (the standard chokepoint) — no
    // ZodError path / message escapes without redaction. Unknown node
    // types fall through to the loose post-template config (the
    // dispatcher errored above if no executor matched).
    const configSchema = NODE_CONFIG_SCHEMAS[node.type as NodeType];
    const parsedConfig = configSchema ? configSchema.parse(resolvedConfig) : resolvedConfig;
    // Enforce the node's declared `config.timeoutMs` at THE single executor
    // chokepoint (Q-01) — before this, only the http fetch + the agent
    // tool-loop honored it, so a hung `tool` / `subworkflow` / `ai` /
    // `transform` executor blocked the worker until the 5-minute stalled-node
    // reaper. `withTimeout` frees the worker at the deadline (throws
    // `NodeTimeoutError` → normal failure path → retry / DLQ) and swallows the
    // abandoned executor's late rejection. No timeout declared → the promise
    // passes through unchanged (behavior-preserving).
    result = await withTimeout(
      executor({
        runId,
        nodeId: node.id,
        orgId,
        workflowId,
        config: parsedConfig,
        context,
        redactedValues,
        dryRun,
      }),
      getNodeTimeoutMs(node),
      { label: node.type },
    );
  } catch (err) {
    // A write-side node that timed out may have already committed its effect
    // (the race abandons, but doesn't cancel, the executor). Flag it so a
    // blind replay can be gated — the flag rides through `redactError` (which
    // returns the same error object) into `error_json` / the DLQ.
    if (err instanceof NodeTimeoutError) err.writeSide = isWriteSideNode(node);
    throw redactError(err, redactedValues);
  }

  if (result.status === "waiting") {
    const metadata = result.reason
      ? { reason: result.reason, ...(result.metadata ?? {}) }
      : result.metadata;
    return {
      status: "waiting",
      metadata: redactValues(metadata, redactedValues),
    };
  }

  // Defense-in-depth: if any output value echoes a resolved secret/env value
  // (e.g. an HTTP node returning the Authorization header it just sent),
  // strip the plaintext value before it is persisted. The actual upstream
  // call happened with the resolved value; we just don't keep it in our DB.
  return {
    status: "succeeded",
    output: redactValues(result.output ?? {}, redactedValues),
  };
}
