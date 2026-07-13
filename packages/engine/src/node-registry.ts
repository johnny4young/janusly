/**
 * Node executor registry — maps every `WorkflowNode["type"]` to its async
 * executor. Sister module to `tool-registry.ts` (which exposes side-effect
 * tools to agent planners and `tool` nodes).
 *
 * Each executor receives a `NodeExecutionContext` (the parsed node config +
 * the run-wide context) and returns either a completed status with output, a
 * paused status (`approval`, `webhook`) for the runtime to checkpoint, or
 * throws for the runtime's retry/DLQ machinery to handle.
 *
 * Used by:
 * - `packages/engine/src/execute-node.ts` — `executor = nodeExecutors[node.type]`.
 * - The agent planner inside `agent` and `multi_agent` executors invokes
 *   `executeTool` from `tool-registry.ts`.
 *
 * Invariants:
 * - `multi_agent.*` event payloads are part of the contract that
 *   `apps/web/src/MultiAgentTimeline.tsx` consumes — don't rename event types
 *   without also updating the web consumer.
 * - The `ai` node routes through the provider-neutral `LlmClient` from
 *   `@janusly/ai`, wraps the call in try/catch, and returns
 *   `{ mode: "fallback", aiError, ... }` on failure — see AGENTS.md.
 * - `http` and the `http.request` tool both go through `fetchHttpTarget`,
 *   preserving the SSRF + DNS-rebinding pin.
 * - `tool` and agent tool dispatch both pass the cached org-config snapshot
 *   through the execution context; do not reintroduce a tool-name allowlist.
 * - Adding a new node type requires updating `nodeTypeValues` in
 *   `@janusly/shared` so the schema and the registry stay in lockstep.
 */

import { loadRootEnv } from "@janusly/db";
import { createLlmClient, resolveLlmConfig, type LlmClient } from "@janusly/ai";
import { WorkflowInputSchema } from "@janusly/shared";
import {
  applyOrgConfigToEnv,
  getOrgConfigSnapshot,
  type OrgConfigSnapshot,
} from "@janusly/data";
import { evaluateExpression } from "./expression";
import { withTimeout } from "./core/timeout";
import { executeTool, isToolWriteSide } from "./tool-registry";
import { planAgentTool, planAgentToolWithLLM, type AgentPlanResult } from "./agent-planner";
import type { AgentNodeConfig } from "./node-configs";
import { appendEvent } from "./persistence";
import { resolvePromptRef } from "./prompt-resolver";
import { getRunMemory, summarizeMemory } from "./memory";
import { recallAgentEpisodes, recordAgentEpisode } from "./agent-memory";
import { mapInput } from "./template";
import { consumeStreamToPreview, fetchHttpTarget } from "./http-policy";
import { hasFailureSignal } from "./failure-signal";
import { checkBudget } from "./budget";
import { subworkflowExecutor } from "./subworkflow";
import { waitUntilExecutor } from "./wait-until";
import { joinExecutor, parallelForkExecutor } from "./parallel-fork";
import { scheduleExecutor } from "./schedule";
import { emailReceivedExecutor, fileDroppedExecutor, mcpServerEventExecutor } from "./triggers";
import { signResumeToken } from "./secrets";
import { executeMcpTool, readMcpClientWritesEnabled, resolveMcpClientRateLimitPerMin, resolveStdioSandboxConfig } from "./mcp-tool-executor";

loadRootEnv();

export type NodeContext = {
  runId: string;
  nodeId: string;
  /** Multi-tenant scope. Plumbed by `executeNode` from `runs.orgId` so the
   * `ai` node and `agent` planner can attribute usage telemetry. */
  orgId: string;
  /**
   * Workflow id for the active run, plumbed by `executeNode` via
   * `getRunMetadata`. Forwarded to `LlmClient.generateText` /
   * `generateObject` context so the recorder writes
   * `metadata.workflowId` and the `GET /billing/usage?breakdown=workflow`
   * surface can attribute cost per workflow. `null` when the workflow
   * row was deleted between scheduling and node execution (left-join
   * miss in `getRunMetadata`).
   */
  workflowId: string | null;
  config: any;
  context: Record<string, any>;
  /** Resolved secret values that must never be persisted by executors. */
  redactedValues?: string[];
  /**
   * True when this node is executing inside a sandbox/validation run
   * (`runs.replayMode === "validation"`). Plumbed by `executeNode` from
   * the run row. Write-side actions — HTTP non-safe methods (POST / PUT
   * / PATCH / DELETE), tools flagged `writeSide` in the registry — are
   * gated when this is true: the executor emits a `node.dry_run.skipped`
   * (or `tool.dry_run.skipped`) event and returns a stub result instead
   * of mutating external state. Read-side actions still execute so the
   * validation run produces a real terminal status.
   */
  dryRun?: boolean;
};

/** HTTP methods that read state without mutating it; safe to execute in dryRun mode. */
const SAFE_HTTP_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * True when a node could commit an external side effect — a non-safe HTTP
 * method or a `writeSide` tool. Same taxonomy the sandbox uses to dry-run-skip
 * write-side actions; reused by `execute-node.ts` to flag a `NODE_TIMEOUT`
 * whose executor may have partially completed its effect (Q-01). Conservative:
 * node types whose write-side-ness isn't statically known (agent tool calls,
 * subworkflows) return `false` here — those loops carry their own timeouts.
 */
export function isWriteSideNode(node: { type: string; config?: { method?: unknown; tool?: unknown } }): boolean {
  if (node.type === "http") {
    return !SAFE_HTTP_METHODS.has(String(node.config?.method ?? "GET").toUpperCase());
  }
  if (node.type === "tool") {
    const tool = node.config?.tool;
    return typeof tool === "string" && isToolWriteSide(tool);
  }
  return false;
}

export type NodeExecutionResult =
  | { status: "completed"; output?: Record<string, unknown> }
  | { status: "waiting"; reason?: string; metadata?: Record<string, unknown> };

export type NodeExecutor = (ctx: NodeContext) => Promise<NodeExecutionResult>;

function fallbackAiResponse(prompt: string, context: Record<string, any>) {
  const contextKeys = Object.keys(context).filter(key => !["orgId", "userId", "createdBy"].includes(key));
  return [
    "AI fallback response.",
    `Prompt: ${previewText(prompt)}`,
    contextKeys.length ? `Available context: ${contextKeys.join(", ")}.` : "No prior node context was available.",
    "Configure an LLM API key (OPENAI_API_KEY or ANTHROPIC_API_KEY) to generate a model-written answer.",
  ].join("\n");
}

function previewText(value: string, maxLength = 700) {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function createTenantLlmClient(orgConfig: OrgConfigSnapshot): LlmClient | null {
  const llmConfig = resolveLlmConfig(applyOrgConfigToEnv(orgConfig));
  return llmConfig ? createLlmClient(llmConfig) : null;
}

async function getTenantLlmClient(orgId: string): Promise<LlmClient | null> {
  return createTenantLlmClient(await getOrgConfigSnapshot(orgId));
}

function withHttpToolDefaults(
  tool: string,
  input: unknown,
  orgConfig: OrgConfigSnapshot,
): unknown {
  if (tool !== "http.request" || typeof input !== "object" || input === null || Array.isArray(input)) return input;
  const next = { ...(input as Record<string, unknown>) };
  next.timeoutMs ??= orgConfig.http.timeoutMs;
  next.maxResponseBytes ??= orgConfig.http.maxResponseBytes;
  next.maxRedirects ??= orgConfig.http.maxRedirects;
  // When the operator opted into streaming and didn't pass a per-call
  // preview cap, fall back to the tenant default so a low per-org cap
  // applies without the operator having to set it on every node.
  if (next.bodyMode === "stream") {
    next.streamPreviewBytes ??= orgConfig.http.streamPreviewBytes;
  }
  return next;
}

function dryRunToolSkipPayload(tool: string, input: unknown): Record<string, unknown> | null {
  if (!isToolWriteSide(tool)) return null;
  const inputObj = (input ?? {}) as Record<string, unknown>;
  const method = typeof inputObj.method === "string" ? inputObj.method.toUpperCase() : "GET";
  const isHttpRead = tool === "http.request" && SAFE_HTTP_METHODS.has(method);
  if (isHttpRead) return null;
  return {
    reason: "write-side tool skipped in validation mode",
    tool,
    method: tool === "http.request" ? method : undefined,
  };
}

/** One recorded agent-loop step: the plan, the tool result, and the reflection (when enabled). */
type AgentLoopStepRecord = {
  iteration: number;
  plan: AgentPlanResult;
  result: unknown;
  reflection: AgentReflection | null;
};

/** Reflection verdict emitted after a tool call when `config.reflection` is on. */
type AgentReflection = {
  agent: string | undefined;
  iteration: number;
  decision: "retry" | "accept";
  reason: string;
};

async function runAgentLoop(ctx: NodeContext, agentConfig: AgentNodeConfig, eventPrefix = "agent") {
  const planner = agentConfig.planner ?? "rules";
  const maxSteps = agentConfig.maxSteps ?? 3;
  const reflectionEnabled = Boolean(agentConfig.reflection);
  const orgConfig = await getOrgConfigSnapshot(ctx.orgId);
  const llm = planner === "openai" ? createTenantLlmClient(orgConfig) : undefined;

  const memory = await getRunMemory(ctx.runId);
  const summarizedMemory = summarizeMemory(memory);

  // Cross-run episodic recall feeds the LLM planner only (the deterministic
  // rules planner ignores memory) — skip the embedding call otherwise. Empty
  // when memory is off / the episodic kind is disallowed, so the prompt is then
  // byte-for-byte today's.
  const episodicBlock = planner === "openai"
    ? (await recallAgentEpisodes({
        orgId: ctx.orgId,
        workflowId: ctx.workflowId ?? undefined,
        goal: agentConfig.goal ?? "",
      })).block
    : "";

  await appendEvent(ctx.runId, ctx.nodeId, `${eventPrefix}.started`, {
    name: agentConfig.name,
    role: agentConfig.role,
    persona: agentConfig.persona,
    planner,
    maxSteps,
    reflection: reflectionEnabled,
    goal: agentConfig.goal,
    memory: summarizedMemory,
  });

  const steps: AgentLoopStepRecord[] = [];
  let lastResult: unknown = null;
  let lastReflection: AgentReflection | null = null;

  for (let i = 0; i < maxSteps; i++) {
    await appendEvent(ctx.runId, ctx.nodeId, `${eventPrefix}.step.started`, { agent: agentConfig.name, iteration: i });

    const planningContext = { context: ctx.context, memory: summarizedMemory, steps, lastReflection };
    const plan: AgentPlanResult = planner === "openai"
      ? await planAgentToolWithLLM(agentConfig, planningContext, steps, llm, {
          orgId: ctx.orgId,
          runId: ctx.runId,
          nodeId: ctx.nodeId,
          workflowId: ctx.workflowId ?? undefined,
        }, episodicBlock)
      : planAgentTool(agentConfig, planningContext);

    await appendEvent(ctx.runId, ctx.nodeId, `${eventPrefix}.step.planned`, { agent: agentConfig.name, iteration: i, plan });

    if (plan.done) {
      await appendEvent(ctx.runId, ctx.nodeId, `${eventPrefix}.completed`, {
        agent: agentConfig.name,
        iteration: i,
        finalAnswer: plan.finalAnswer,
        steps,
        reflection: lastReflection,
      });

      // Record the episode for cross-run recall. Skipped in dry-run/validation
      // so sandbox runs don't pollute durable memory; never throws.
      if (!ctx.dryRun) {
        await recordAgentEpisode({
          orgId: ctx.orgId,
          workflowId: ctx.workflowId ?? undefined,
          runId: ctx.runId,
          goal: agentConfig.goal ?? "",
          outcome: String(plan.finalAnswer ?? "Done"),
          success: true,
          stepCount: steps.length,
        });
      }

      return { memory: summarizedMemory, steps, finalAnswer: plan.finalAnswer, reflection: lastReflection };
    }

    const toolInput = withHttpToolDefaults(plan.tool, plan.input, orgConfig);
    const dryRunSkip = ctx.dryRun ? dryRunToolSkipPayload(plan.tool, toolInput) : null;
    if (dryRunSkip) {
      const result = { tool: plan.tool, dryRun: true, skipped: true };
      await appendEvent(ctx.runId, ctx.nodeId, "tool.dry_run.skipped", {
        ...dryRunSkip,
        agent: agentConfig.name,
        iteration: i,
      });
      await appendEvent(ctx.runId, ctx.nodeId, `${eventPrefix}.tool.completed`, {
        agent: agentConfig.name,
        iteration: i,
        tool: plan.tool,
        result,
      });
      steps.push({ iteration: i, plan, result, reflection: lastReflection });
      lastResult = result;
      continue;
    }

    await appendEvent(ctx.runId, ctx.nodeId, `${eventPrefix}.tool.started`, {
      agent: agentConfig.name,
      iteration: i,
      tool: plan.tool,
      input: plan.input,
    });

    const result = await withTimeout(
      executeTool(
        plan.tool,
        toolInput,
        ctx.context,
        {
          orgId: ctx.orgId,
          runId: ctx.runId,
          nodeId: ctx.nodeId,
          workflowId: ctx.workflowId ?? undefined,
          email: orgConfig.email,
          integrations: orgConfig.integrations,
          objectstore: orgConfig.objectstore,
        },
      ),
      agentConfig.timeoutMs,
      { label: `${agentConfig.name ?? "agent"}.${plan.tool}` }
    );

    await appendEvent(ctx.runId, ctx.nodeId, `${eventPrefix}.tool.completed`, {
      agent: agentConfig.name,
      iteration: i,
      tool: plan.tool,
      result,
    });

    if (reflectionEnabled) {
      const decision = hasFailureSignal(result) ? "retry" : "accept";
      lastReflection = {
        agent: agentConfig.name,
        iteration: i,
        decision,
        reason: decision === "retry" ? "The result contains an error-like signal." : "The result looks acceptable.",
      };
      await appendEvent(ctx.runId, ctx.nodeId, `${eventPrefix}.reflection`, lastReflection);
    }

    steps.push({ iteration: i, plan, result, reflection: lastReflection });
    lastResult = result;
  }

  await appendEvent(ctx.runId, ctx.nodeId, `${eventPrefix}.completed`, {
    agent: agentConfig.name,
    reason: "maxSteps reached",
    steps,
    finalResult: lastResult,
    reflection: lastReflection,
  });

  // Record the episode (step budget exhausted without an explicit `done`).
  // Skipped in dry-run/validation; never throws.
  if (!ctx.dryRun) {
    await recordAgentEpisode({
      orgId: ctx.orgId,
      workflowId: ctx.workflowId ?? undefined,
      runId: ctx.runId,
      goal: agentConfig.goal ?? "",
      outcome: `Reached step budget (${steps.length}) without completing. Last result: ${safeOutcome(lastResult)}`,
      success: false,
      stepCount: steps.length,
    });
  }

  return { memory: summarizedMemory, steps, finalResult: lastResult, reflection: lastReflection };
}

/** Compact, JSON-safe one-line projection of an agent's last tool result for an
 *  episode summary (bounded; the substrate scrubs + caps the final content). */
function safeOutcome(value: unknown): string {
  if (value == null) return "none";
  try {
    return JSON.stringify(value).slice(0, 500);
  } catch {
    return String(value).slice(0, 500);
  }
}

function buildAgentConfig(ctx: NodeContext, agent: any, index: number, sharedContext: any, results: any[]) {
  return {
    ...agent,
    name: agent.name ?? `agent_${index + 1}`,
    planner: agent.planner ?? ctx.config.planner ?? "rules",
    maxSteps: agent.maxSteps ?? ctx.config.maxSteps ?? 2,
    timeoutMs: agent.timeoutMs ?? ctx.config.timeoutMs,
    reflection: agent.reflection ?? ctx.config.reflection ?? true,
    goal: mapInput(agent.goal ?? ctx.config.goal ?? "Complete the task", {
      context: sharedContext,
      previousAgents: results,
    }),
  };
}

function aggregateCrewResults(results: any[], strategy = "last") {
  if (strategy === "all") return results;
  if (strategy === "first") return results[0]?.result?.finalAnswer ?? results[0]?.result?.finalResult ?? results[0] ?? null;
  if (strategy === "best-effort") {
    return results.find(item => item.status !== "failed")?.result?.finalAnswer
      ?? results.find(item => item.status !== "failed")?.result?.finalResult
      ?? results.at(-1)?.result
      ?? null;
  }
  return results.at(-1)?.result?.finalAnswer ?? results.at(-1)?.result?.finalResult ?? null;
}

export const nodeRegistry: Record<string, NodeExecutor> = {
  http: async (ctx) => {
    const { url, method, headers, body, timeoutMs, maxResponseBytes, maxRedirects, bodyMode, streamPreviewBytes } = ctx.config;
    const resolvedMethod = (method ?? "GET").toUpperCase();

    // In sandbox/validation mode, skip non-safe methods so the validation
    // run can't double-charge an external API or insert a duplicate row.
    // Read-side methods (GET / HEAD / OPTIONS) still execute — they give
    // the validation real signal without mutating external state.
    if (ctx.dryRun && !SAFE_HTTP_METHODS.has(resolvedMethod)) {
      await appendEvent(ctx.runId, ctx.nodeId, "node.dry_run.skipped", {
        reason: "write-side HTTP method skipped in validation mode",
        method: resolvedMethod,
        url,
      });
      return { status: "completed", output: { statusCode: 0, ok: true, body: null, dryRun: true } };
    }

    const orgConfig = await getOrgConfigSnapshot(ctx.orgId);
    const resolvedTimeoutMs = typeof timeoutMs === "number" ? timeoutMs : orgConfig.http.timeoutMs;
    const resolvedMaxBytes = typeof maxResponseBytes === "number" ? maxResponseBytes : orgConfig.http.maxResponseBytes;
    const resolvedMaxRedirects = typeof maxRedirects === "number" ? maxRedirects : orgConfig.http.maxRedirects;

    // Streaming opt-in: the body comes back as a ReadableStream the executor
    // immediately consumes into a bounded preview before returning. The
    // persisted output shape is a JSON-safe `{ body, streamed, streamedBytes,
    // streamTruncated }` so downstream nodes / templates / persistence see
    // a string preview, not a live stream.
    if (bodyMode === "stream") {
      const previewCap = typeof streamPreviewBytes === "number" && Number.isFinite(streamPreviewBytes)
        ? Math.max(1024, Math.min(streamPreviewBytes, 1_048_576))
        : orgConfig.http.streamPreviewBytes;
      const streaming = await fetchHttpTarget(url, {
        method: resolvedMethod,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        timeoutMs: resolvedTimeoutMs,
        maxResponseBytes: resolvedMaxBytes,
        maxRedirects: resolvedMaxRedirects,
        bodyMode: "stream",
      });
      if (!streaming.ok) {
        // Drain the stream so the socket releases — `streamBoundedBody`'s
        // cancel path aborts the shared controller cleanly.
        try { await streaming.body.cancel(); } catch { /* best effort */ }
        throw new Error(`HTTP failed: ${streaming.statusCode}`);
      }
      const { preview, originalBytes, truncated } = await consumeStreamToPreview(streaming.body, previewCap);
      return {
        status: "completed",
        output: {
          statusCode: streaming.statusCode,
          ok: streaming.ok,
          body: preview,
          streamed: true,
          streamedBytes: originalBytes,
          streamTruncated: truncated,
        },
      };
    }

    const result = await fetchHttpTarget(url, {
      method: resolvedMethod,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      // Optional bounds — nodes that fetch large payloads or call slow APIs
      // pass these through; otherwise tenant/runtime defaults apply.
      timeoutMs: resolvedTimeoutMs,
      maxResponseBytes: resolvedMaxBytes,
      maxRedirects: resolvedMaxRedirects,
    });

    if (!result.ok) throw new Error(`HTTP failed: ${result.statusCode}`);
    return { status: "completed", output: { statusCode: result.statusCode, ok: result.ok, body: result.body } };
  },

  condition: async (ctx) => {
    const { expression } = ctx.config;
    const result = evaluateExpression(expression, { context: ctx.context, inputs: ctx.config });
    return { status: "completed", output: { result } };
  },

  transform: async (ctx) => {
    const output = mapInput(ctx.config.mapping, { context: ctx.context, inputs: ctx.config });
    return { status: "completed", output };
  },

  loop: async (ctx) => {
    const rawItems = mapInput(ctx.config.items, { context: ctx.context, inputs: ctx.config });
    const items = Array.isArray(rawItems) ? rawItems : typeof rawItems === "string" ? rawItems.split(",").map(item => item.trim()).filter(Boolean) : [];
    const results = items.map((item, index) => mapInput(ctx.config.mapping ?? { item: "{{item}}", index: "{{index}}" }, { context: ctx.context, inputs: ctx.config, item, index }));
    await appendEvent(ctx.runId, ctx.nodeId, "loop.completed", { count: results.length, items: results });
    return { status: "completed", output: { count: results.length, items: results } };
  },

  tool: async (ctx) => {
    const { tool, input } = ctx.config;
    const mappedInput = mapInput(input, { context: ctx.context, inputs: ctx.config });
    // One cached snapshot feeds every tool node. Keeping a name allowlist
    // here let newly registered tools (for example pdf.generate) silently
    // fall back to process defaults instead of their tenant configuration.
    const orgConfig = await getOrgConfigSnapshot(ctx.orgId);
    const toolInput = tool === "http.request"
      ? withHttpToolDefaults(tool, mappedInput, orgConfig)
      : mappedInput;

    // In sandbox/validation mode, skip write-side tool invocations.
    // For `http.request` the write-side intent depends on the method —
    // safe methods (GET / HEAD / OPTIONS) still execute so the validation
    // run can read state without mutating it; non-safe methods are
    // skipped to avoid double-charging external APIs.
    const dryRunSkip = ctx.dryRun ? dryRunToolSkipPayload(tool, toolInput) : null;
    if (dryRunSkip) {
      await appendEvent(ctx.runId, ctx.nodeId, "tool.dry_run.skipped", dryRunSkip);
      return { status: "completed", output: { tool, dryRun: true, skipped: true } };
    }

    await appendEvent(ctx.runId, ctx.nodeId, "tool.started", { tool, input: toolInput });
    const result = await executeTool(tool, toolInput, ctx.context, {
      orgId: ctx.orgId,
      runId: ctx.runId,
      nodeId: ctx.nodeId,
      workflowId: ctx.workflowId ?? undefined,
      email: orgConfig?.email,
      integrations: orgConfig?.integrations,
      objectstore: orgConfig?.objectstore,
    });
    await appendEvent(ctx.runId, ctx.nodeId, "tool.completed", { tool, result });
    return { status: "completed", output: { tool, result } };
  },

  agent: async (ctx) => {
    const output = await runAgentLoop(ctx, ctx.config, "agent");
    return { status: "completed", output };
  },

  multi_agent: async (ctx) => {
    const agents = Array.isArray(ctx.config.agents) ? ctx.config.agents : [];
    const mode = ctx.config.mode ?? "sequential";
    const aggregation = ctx.config.aggregation ?? "last";
    const continueOnError = Boolean(ctx.config.continueOnError);
    const sharedContext: Record<string, any> = { ...ctx.context };
    const results: any[] = [];

    await appendEvent(ctx.runId, ctx.nodeId, "multi_agent.started", { mode, aggregation, count: agents.length, goal: ctx.config.goal });

    if (mode === "parallel") {
      const parallelResults = await Promise.allSettled(
        agents.map(async (agent: any, index: number) => {
          const agentConfig = buildAgentConfig(ctx, agent, index, sharedContext, results);

          await appendEvent(ctx.runId, ctx.nodeId, "multi_agent.agent.started", {
            index,
            name: agentConfig.name,
            role: agentConfig.role,
            persona: agentConfig.persona,
            goal: agentConfig.goal,
            mode: "parallel",
          });

          const result = await runAgentLoop({ ...ctx, context: sharedContext }, agentConfig, `multi_agent.agent.${index}`);
          return { index, name: agentConfig.name, role: agentConfig.role, status: "completed", result };
        })
      );

      for (const [index, settled] of parallelResults.entries()) {
        const agent = agents[index] ?? {};
        const name = agent.name ?? `agent_${index + 1}`;

        if (settled.status === "fulfilled") {
          results.push(settled.value);
          sharedContext[`agent_${index + 1}`] = { output: settled.value.result };
          sharedContext[settled.value.name] = { output: settled.value.result };
          await appendEvent(ctx.runId, ctx.nodeId, "multi_agent.agent.completed", settled.value);
        } else {
          const failed = { index, name, role: agent.role, status: "failed", error: { message: settled.reason?.message ?? String(settled.reason) } };
          results.push(failed);
          await appendEvent(ctx.runId, ctx.nodeId, "multi_agent.agent.failed", failed);
          if (!continueOnError) throw new Error(`Multi-agent ${name} failed: ${failed.error.message}`);
        }
      }
    } else {
      for (const [index, agent] of agents.entries()) {
        const agentConfig = buildAgentConfig(ctx, agent, index, sharedContext, results);

        await appendEvent(ctx.runId, ctx.nodeId, "multi_agent.agent.started", {
          index,
          name: agentConfig.name,
          role: agentConfig.role,
          persona: agentConfig.persona,
          goal: agentConfig.goal,
          mode: "sequential",
        });

        try {
          const result = await runAgentLoop({ ...ctx, context: sharedContext }, agentConfig, `multi_agent.agent.${index}`);
          const agentResult = { index, name: agentConfig.name, role: agentConfig.role, status: "completed", result };
          results.push(agentResult);
          sharedContext[`agent_${index + 1}`] = { output: result };
          sharedContext[agentConfig.name] = { output: result };
          await appendEvent(ctx.runId, ctx.nodeId, "multi_agent.agent.completed", agentResult);
        } catch (err: any) {
          const failed = { index, name: agentConfig.name, role: agentConfig.role, status: "failed", error: { message: err.message } };
          results.push(failed);
          await appendEvent(ctx.runId, ctx.nodeId, "multi_agent.agent.failed", failed);
          if (!continueOnError) throw err;
        }
      }
    }

    const finalAnswer = aggregateCrewResults(results, aggregation);
    await appendEvent(ctx.runId, ctx.nodeId, "multi_agent.completed", { mode, aggregation, count: results.length, finalAnswer, agents: results });
    return { status: "completed", output: { mode, aggregation, count: results.length, finalAnswer, agents: results } };
  },

  agent_reflection: async (ctx) => {
    const input = mapInput(ctx.config.input ?? "", { context: ctx.context, inputs: ctx.config });
    const decision = hasFailureSignal(input) ? "retry" : "accept";
    const reason = decision === "retry" ? "The inspected input contains failure signals." : "The inspected input looks valid.";
    await appendEvent(ctx.runId, ctx.nodeId, "agent.reflection", { decision, reason, input });
    return { status: "completed", output: { decision, reason, input } };
  },

  /**
   * Invariant (AGENTS.md "AI integration"): SDK/quota/network
   * errors must return `{ mode: "fallback", aiError, response }`.
   * Throwing here bypasses the AI fallback safety net into retry/DLQ.
   */
  ai: async (ctx) => {
    // PromptOps seam: when `config.promptRef` is set, resolve it via the
    // registry resolver before any LLM call. The resolver throws typed
    // errors (MissingPromptError / MissingVariableError /
    // RecursivePromptIncludeError) BEFORE token spend; we surface those
    // as `mode: "fallback"` per the AI-fallback contract.
    const promptRefRaw = ctx.config.promptRef;
    const hasPromptRef =
      promptRefRaw &&
      typeof promptRefRaw === "object" &&
      typeof (promptRefRaw as { name?: unknown }).name === "string";
    const hasInlinePrompt =
      typeof ctx.config.prompt === "string" && ctx.config.prompt.length > 0;

    if (hasPromptRef && hasInlinePrompt) {
      await appendEvent(ctx.runId, ctx.nodeId, "ai.prompt_config_ambiguous", {
        message: "both prompt and promptRef are set; promptRef wins. Set only one.",
      });
    }

    let prompt: string;
    let resolvedPromptMeta: { name: string; version: number } | undefined;
    if (hasPromptRef && ctx.orgId) {
      const ref = promptRefRaw as { name: string; version?: number };
      try {
        const resolved = await resolvePromptRef({
          orgId: ctx.orgId,
          ref: { name: ref.name, version: ref.version },
          nodeContext: {
            variables:
              ctx.config.variables && typeof ctx.config.variables === "object"
                ? (ctx.config.variables as Record<string, unknown>)
                : undefined,
          },
        });
        prompt = resolved.resolvedText;
        resolvedPromptMeta = { name: resolved.promptName, version: resolved.version };
        await appendEvent(ctx.runId, ctx.nodeId, "ai.prompt_resolved", {
          promptName: resolved.promptName,
          version: resolved.version,
        });
      } catch (error) {
        const code =
          (error as { code?: string }).code ?? "prompt_resolver_failure";
        const message = error instanceof Error ? error.message : String(error);
        await appendEvent(ctx.runId, ctx.nodeId, "ai.prompt_resolver_failed", {
          code,
          message,
        });
        // The AI-fallback contract requires this path to NEVER throw — guard
        // the fallback-response generation too, so a malformed ctx.context
        // degrades to a minimal envelope instead of bubbling an exception.
        let fallback: unknown;
        try {
          fallback = fallbackAiResponse(message, ctx.context);
        } catch {
          fallback = undefined;
        }
        return {
          status: "completed",
          output: {
            mode: "fallback",
            aiError: code,
            promptRef: { name: ref.name, version: ref.version ?? null },
            error: message,
            ...(fallback !== undefined ? { response: fallback } : {}),
            contextKeys: Object.keys(ctx.context ?? {}),
          },
        };
      }
    } else {
      prompt = String(ctx.config.prompt ?? "Summarize workflow");
    }

    await appendEvent(ctx.runId, ctx.nodeId, "ai.prompt", { prompt: previewText(prompt), contextKeys: Object.keys(ctx.context), promptRef: resolvedPromptMeta });
    const llm = await getTenantLlmClient(ctx.orgId);
    // `config.model` accepts a bare model id ("gpt-4o-mini") OR a
    // `"<provider>/<model>"` spec ("anthropic/claude-haiku-4-5"); the
    // provider abstraction parses it so this node works against any backend.
    const modelHint = typeof ctx.config.model === "string" ? ctx.config.model : undefined;

    if (!llm) {
      return {
        status: "completed",
        output: {
          mode: "fallback",
          prompt: previewText(prompt),
          response: fallbackAiResponse(String(prompt), ctx.context),
          contextKeys: Object.keys(ctx.context),
        },
      };
    }

    // Budget chokepoint. The block path degrades to mode:"fallback" with
    // aiError:"budget_exceeded" so the workflow run continues to the next
    // node via the existing AI-fallback path. AGENTS.md AI-fallback
    // contract holds.
    const budget = ctx.orgId
      ? await checkBudget({ orgId: ctx.orgId, workflowId: ctx.workflowId ?? null })
      : null;
    if (budget && !budget.allowed) {
      await appendEvent(ctx.runId, ctx.nodeId, "ai.budget_exceeded", {
        scope: budget.resolvedScope,
        monthlyUsdSpent: budget.monthlyUsdSpent,
        monthlyUsdLimit: budget.monthlyUsdLimit,
      });
      return {
        status: "completed",
        output: {
          mode: "fallback",
          modelHint,
          prompt: previewText(prompt),
          aiError: "budget_exceeded",
          response: fallbackAiResponse(String(prompt), ctx.context),
          budget: {
            monthlyUsdSpent: budget.monthlyUsdSpent,
            monthlyUsdLimit: budget.monthlyUsdLimit,
            policy: budget.policy,
            exceededAt: budget.exceededAt,
          },
        },
      };
    }

    try {
      const result = await llm.generateText({
        system:
          "You are Janusly, an AI operator for business workflows. Answer clearly for an operator, and keep the response concise.",
        prompt: JSON.stringify({ prompt, context: ctx.context }),
        modelHint,
        context: { orgId: ctx.orgId, runId: ctx.runId, nodeId: ctx.nodeId, workflowId: ctx.workflowId ?? undefined },
      });

      return {
        status: "completed",
        output: {
          mode: "ai",
          model: result.model,
          provider: result.provider,
          prompt: previewText(prompt),
          response: result.text,
          // Surface tokens + cost + latency on the node's stateJson
          // so the web Inspector renders the per-node usage footer.
          usage: result.usage,
          costUsd: result.costUsd ?? null,
          latencyMs: result.latencyMs,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : "AI request failed";
      await appendEvent(ctx.runId, ctx.nodeId, "ai.fallback", { error: message, modelHint });
      return {
        status: "completed",
        output: {
          mode: "fallback",
          modelHint,
          prompt: previewText(prompt),
          aiError: message,
          response: fallbackAiResponse(String(prompt), ctx.context),
        },
      };
    }
  },

  // `webhook` / `approval` keep the legacy checkpoint-coordinate token:
  // the authenticated `/resume` route still gates the action, and the token
  // mostly lets the UI/API point at the waiting node. `human_form` below uses
  // an HMAC-signed token because form links can leave the app context and
  // carry user-submitted data that becomes node output.
  webhook: async (ctx) => ({
    status: "waiting",
    reason: "Waiting for external webhook resume",
    metadata: { kind: "webhook", resumeToken: `${ctx.runId}:${ctx.nodeId}` },
  }),
  approval: async (ctx) => {
    const title = typeof ctx.config.title === "string" && ctx.config.title.trim()
      ? ctx.config.title.trim()
      : typeof ctx.config.message === "string" && ctx.config.message.trim()
        ? ctx.config.message.trim()
        : undefined;
    const description = typeof ctx.config.description === "string" && ctx.config.description.trim()
      ? ctx.config.description.trim()
      : undefined;
    return {
      status: "waiting",
      reason: "Waiting for human approval",
      metadata: {
        kind: "approval",
        title,
        description,
        resumeToken: `${ctx.runId}:${ctx.nodeId}`,
      },
    };
  },
  human_form: async (ctx) => {
    const schema = WorkflowInputSchema.parse(ctx.config.schema);
    const title = typeof ctx.config.title === "string" && ctx.config.title.trim()
      ? ctx.config.title.trim()
      : "Human input required";
    const description = typeof ctx.config.description === "string" && ctx.config.description.trim()
      ? ctx.config.description.trim()
      : undefined;
    return {
      status: "waiting",
      reason: "Waiting for form submission",
      metadata: {
        kind: "human_form",
        title,
        description,
        schema,
        resumeToken: signResumeToken({ orgId: ctx.orgId, runId: ctx.runId, nodeId: ctx.nodeId, purpose: "human_form" }),
      },
    };
  },
  noop: async () => ({ status: "completed" }),

  // mcp_tool node — invokes a registered external MCP server's tool
  // through `executeMcpTool`. The executor enforces:
  //   1. multi-tenant scope (org-scoped repo lookups);
  //   2. connection + tool enabled flags;
  //   3. write-side dry-run skip (sandbox replay);
  //   4. two-flag write consent (process env + tenant config);
  //   5. env-ref resolution (generic error on miss; never echoes env var name);
  //   6. per-tool rate-limit via `getEngineRateLimiter()`;
  //   7. timeout + error containment.
  // The envelope is `{ ok, output?, error?, latencyMs }` — the
  // executor NEVER throws on runtime failures. Failure cases throw
  // here so the run's existing retry / DLQ machinery applies (matches
  // the `http` node contract).
  mcp_tool: async (ctx) => {
    const { connectionAlias, toolName, input, timeoutMs } = ctx.config as {
      connectionAlias?: unknown;
      toolName?: unknown;
      input?: unknown;
      timeoutMs?: unknown;
    };
    if (typeof connectionAlias !== "string" || !connectionAlias) throw new Error("mcp_tool requires config.connectionAlias");
    if (typeof toolName !== "string" || !toolName) throw new Error("mcp_tool requires config.toolName");

    const mappedInput = input && typeof input === "object" && !Array.isArray(input)
      ? mapInput(input as Record<string, unknown>, { context: ctx.context, inputs: ctx.config })
      : {};
    const orgConfig = await getOrgConfigSnapshot(ctx.orgId);

    await appendEvent(ctx.runId, ctx.nodeId, "mcp_tool.started", {
      connectionAlias,
      toolName,
    });
    const envelope = await executeMcpTool({
      orgId: ctx.orgId,
      connectionAlias,
      toolName,
      input: mappedInput as Record<string, unknown>,
      timeoutMs: typeof timeoutMs === "number" ? timeoutMs : undefined,
      dryRun: ctx.dryRun,
      runId: ctx.runId,
      nodeId: ctx.nodeId,
      workflowId: ctx.workflowId ?? undefined,
      writeConsentProcess: readMcpClientWritesEnabled(),
      writeConsentTenant: orgConfig.mcp.clientWriteConsent,
      rateLimitPerMin: resolveMcpClientRateLimitPerMin(orgConfig.mcp.clientRateLimitPerMin),
      stdioSandbox: resolveStdioSandboxConfig(orgConfig.mcp),
      onAudit: async ({ ok, error, latencyMs, writeSide, sandboxFailureCode, capturedStderrTail }) => {
        // Always emit the per-call timeline event so the run timeline
        // shows the outcome. Sandbox-driven kills get an extra
        // `mcp.sandbox.terminated`-shaped event (in addition to the
        // completed event) carrying the typed reason + redacted tail so
        // operators see WHY the call ended without re-running the call.
        await appendEvent(ctx.runId, ctx.nodeId, "mcp_tool.completed", {
          connectionAlias,
          toolName,
          ok,
          error,
          latencyMs,
          writeSide,
          ...(sandboxFailureCode ? { sandboxFailureCode } : {}),
          ...(capturedStderrTail ? { stderrTail: capturedStderrTail } : {}),
        });
        if (sandboxFailureCode) {
          await appendEvent(ctx.runId, ctx.nodeId, "mcp.sandbox.terminated", {
            connectionAlias,
            toolName,
            reason: sandboxFailureCode,
            stderrTail: capturedStderrTail ?? null,
            writeSide,
          });
        }
      },
    });
    if (!envelope.ok) {
      throw new Error(`mcp_tool failed: ${envelope.error ?? "unknown"}`);
    }
    return { status: "completed", output: envelope.output ?? {} };
  },

  // Subworkflow node — async pause-and-resume against a child run.
  // Implementation lives in `subworkflow.ts` to keep this registry focused on
  // dispatch + the tightly-coupled inline executors.
  subworkflow: subworkflowExecutor,

  // wait_until node — pauses the run for a configurable ISO 8601 duration.
  // The wake-up is handled by a delayed BullMQ job dispatched in `worker.ts`
  // on `job.name === "wait-resume"`.
  wait_until: waitUntilExecutor,

  // parallel_fork / join — DAG fan-out / fan-in pair. Both are declarative
  // shells over the existing runtime semantics: the fan-out is "this node
  // has multiple outgoing edges", the fan-in is the runtime's existing
  // ALL-AND readiness check (every predecessor must be `succeeded` or
  // `skipped` before the join queues), and the atomic single-claim of the
  // join is the existing `tryClaimNodeForQueue` UPDATE...WHERE...pending
  // guard. The executors here only validate and shape outputs.
  parallel_fork: parallelForkExecutor,
  join: joinExecutor,

  // schedule node — passthrough trigger. The cron firing is owned by a
  // BullMQ scheduler registered by `schedule-scheduler.ts` on workflow
  // save; the executor itself just succeeds with `triggeredAt` so
  // downstream nodes have a stable output to read.
  schedule: scheduleExecutor,

  // Event-driven trigger nodes — passthrough triggers (like `schedule`).
  // The actual firing happens at the API ingestion seam
  // (`trigger-ingest-routes.ts`): it persists a structured `trigger_events`
  // row, applies a per-trigger rate-limit storm guard, and spawns a run via
  // `startRun` with the normalized inbound event as the run input. The
  // executors here just succeed with `{ triggeredBy, event }` so downstream
  // nodes can read the inbound payload.
  email_received: emailReceivedExecutor,
  file_dropped: fileDroppedExecutor,
  mcp_server_event: mcpServerEventExecutor,
};
