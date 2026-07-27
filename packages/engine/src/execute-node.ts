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
import { appendEvent, getRunContext, getRunMetadata } from "./persistence";
import {
  MAX_RECORDED_UNRESOLVED_PATHS,
  UnresolvedTemplatePathError,
  redactError,
  redactValues,
  renderTemplateWithRedactions,
} from "./template";
import type { ExecuteNodeInput, NodeExecutionResult } from "./core/types";
import type { NodeType } from "@janusly/shared/src/workflow";
import { isProviderSimulationToolInvocation } from "./tool-execution";

type RenderedConfig = ReturnType<typeof renderTemplateWithRedactions>;

function isConfigRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Multi-agent goals may bind `previousAgents` only after an earlier agent has
 * completed. Resolve every immediately available field now, but preserve that
 * one executor-owned scope inside goals until `buildAgentConfig` binds it.
 */
function renderMultiAgentConfig(
  config: Record<string, unknown>,
  scope: Record<string, unknown>,
): RenderedConfig {
  const redactedValues = new Set<string>();
  const unresolvedPaths = new Set<string>();
  const collect = (part: RenderedConfig): unknown => {
    for (const value of part.redactedValues) redactedValues.add(value);
    for (const path of part.unresolvedPaths) unresolvedPaths.add(path);
    return part.rendered;
  };

  const { agents, goal, ...immediateConfig } = config;
  const rendered = collect(renderTemplateWithRedactions(immediateConfig, scope)) as Record<string, unknown>;
  const deferredGoalRoots = rendered.mode === undefined || rendered.mode === "sequential"
    ? ["previousAgents"]
    : [];

  if (Object.prototype.hasOwnProperty.call(config, "goal")) {
    rendered.goal = collect(renderTemplateWithRedactions(goal, scope, {
      deferredRoots: deferredGoalRoots,
    }));
  }

  if (Object.prototype.hasOwnProperty.call(config, "agents")) {
    rendered.agents = Array.isArray(agents)
      ? agents.map((agent) => {
          if (!isConfigRecord(agent)) {
            return collect(renderTemplateWithRedactions(agent, scope));
          }
          const { goal: agentGoal, ...immediateAgent } = agent;
          const renderedAgent = collect(
            renderTemplateWithRedactions(immediateAgent, scope),
          ) as Record<string, unknown>;
          if (Object.prototype.hasOwnProperty.call(agent, "goal")) {
            renderedAgent.goal = collect(renderTemplateWithRedactions(agentGoal, scope, {
              deferredRoots: deferredGoalRoots,
            }));
          }
          return renderedAgent;
        })
      : collect(renderTemplateWithRedactions(agents, scope));
  }

  return {
    rendered,
    redactedValues: Array.from(redactedValues),
    unresolvedPaths: Array.from(unresolvedPaths),
  };
}

/**
 * Loop mappings and per-item tool inputs bind `item` and `index` inside the
 * loop executor. Resolve the rest of the config now, but keep those two roots
 * intact until each iteration has supplied them. Secret/env/context references
 * in either field still resolve here so redaction and strict-policy behavior
 * stay unchanged.
 */
function renderNodeConfig(
  nodeType: string,
  config: Record<string, unknown>,
  scope: Record<string, unknown>,
): RenderedConfig {
  if (nodeType === "multi_agent") {
    return renderMultiAgentConfig(config, scope);
  }

  if (nodeType !== "loop") {
    return renderTemplateWithRedactions(config, scope);
  }

  const { mapping, input, ...immediateConfig } = config;
  const immediate = renderTemplateWithRedactions(immediateConfig, scope);
  const deferredFields = [
    ["mapping", mapping],
    ["input", input],
  ] as const;
  const renderedDeferred = deferredFields
    .filter(([key]) => Object.prototype.hasOwnProperty.call(config, key))
    .map(([key, value]) => [key, renderTemplateWithRedactions(value, scope, {
      deferredRoots: ["item", "index"],
    })] as const);
  return {
    rendered: {
      ...(immediate.rendered as Record<string, unknown>),
      ...Object.fromEntries(renderedDeferred.map(([key, value]) => [key, value.rendered])),
    },
    redactedValues: Array.from(new Set([
      ...immediate.redactedValues,
      ...renderedDeferred.flatMap(([, value]) => value.redactedValues),
    ])),
    unresolvedPaths: Array.from(new Set([
      ...immediate.unresolvedPaths,
      ...renderedDeferred.flatMap(([, value]) => value.unresolvedPaths),
    ])),
  };
}

/**
 * Run one node end-to-end: look up org/context, render templates with
 * secret/env tracking, dispatch to the executor, and redact resolved values
 * before returning or rethrowing.
 */
export async function executeNode(
  input: Pick<ExecuteNodeInput, "runId" | "node" | "recoveryClaimToken">,
): Promise<NodeExecutionResult> {
  const { node, runId, recoveryClaimToken } = input;

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
  const validationEffectMode = meta.validationEffectMode ?? "skip";

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

  const { rendered: resolvedConfig, redactedValues, unresolvedPaths } = renderNodeConfig(
    node.type,
    node.config,
    scope,
  );

  if (unresolvedPaths.length > 0) {
    const recordedPaths = unresolvedPaths.slice(0, MAX_RECORDED_UNRESOLVED_PATHS);
    const templatePolicy = meta.templatePolicy ?? "lenient";
    await appendEvent(runId, node.id, "template.unresolved_path", {
      count: unresolvedPaths.length,
      paths: recordedPaths,
      truncated: unresolvedPaths.length > recordedPaths.length,
      policy: templatePolicy,
    });
    if (templatePolicy === "strict") {
      throw new UnresolvedTemplatePathError(unresolvedPaths);
    }
  }

  let result: Awaited<ReturnType<typeof executor>>;
  let renderedWriteSide = false;
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
    const executesQualifiedProviderEffect = dryRun
      && validationEffectMode === "provider_simulation"
      && node.type === "tool"
      && isProviderSimulationToolInvocation(
        String((parsedConfig as Record<string, unknown>).tool ?? ""),
        (parsedConfig as Record<string, unknown>).input,
      );
    renderedWriteSide = (!dryRun || executesQualifiedProviderEffect) && isWriteSideNode({
      type: node.type,
      config: parsedConfig as Record<string, unknown>,
    });
    // Enforce the node's declared `config.timeoutMs` at THE single executor
    // chokepoint — before this, only the http fetch + the agent
    // tool-loop honored it, so a hung `tool` / `subworkflow` / `ai` /
    // `transform` executor blocked the worker until the 5-minute stalled-node
    // reaper. `withTimeout` frees the worker at the deadline (throws
    // `NodeTimeoutError` → normal failure path → retry / DLQ) and swallows the
    // abandoned executor's late rejection. No timeout declared → the promise
    // passes through unchanged (behavior-preserving).
    const timeoutMs = getNodeTimeoutMs(node);
    const timeoutController = timeoutMs ? new AbortController() : undefined;
    result = await withTimeout(
      executor({
        runId,
        nodeId: node.id,
        orgId,
        workflowId,
        config: parsedConfig,
        context,
        redactedValues,
        recoveryClaimToken,
        signal: timeoutController?.signal,
        dryRun,
        validationEffectMode,
        templatePolicy: meta.templatePolicy ?? "lenient",
      }),
      timeoutMs,
      { label: node.type, onTimeout: () => timeoutController?.abort() },
    );
  } catch (err) {
    // A write-side timeout, or any error after a write-side loop starts, may
    // follow a committed external effect (including loop completion-event
    // persistence). Preserve that risk so the runtime suppresses whole-node
    // retries and blind replay can be gated. Timeout also aborts cooperative
    // executors. Other successful write nodes carry writeSideExecuted below.
    if (err instanceof NodeTimeoutError) err.writeSide = renderedWriteSide;
    else if (node.type === "loop" && renderedWriteSide && err instanceof Error) {
      (err as Error & { writeSide?: boolean }).writeSide = true;
    }
    throw redactError(err, redactedValues);
  }

  if (result.status === "waiting") {
    const metadata = result.reason
      ? { reason: result.reason, ...(result.metadata ?? {}) }
      : result.metadata;
    return {
      status: "waiting",
      metadata: redactValues(metadata, redactedValues),
      ...(result.checkpointPersisted ? { checkpointPersisted: true } : {}),
    };
  }

  // Defense-in-depth: if any output value echoes a resolved secret/env value
  // (e.g. an HTTP node returning the Authorization header it just sent),
  // strip the plaintext value before it is persisted. The actual upstream
  // call happened with the resolved value; we just don't keep it in our DB.
  return {
    status: "succeeded",
    output: redactValues(result.output ?? {}, redactedValues),
    ...(renderedWriteSide ? { writeSideExecuted: true } : {}),
  };
}
