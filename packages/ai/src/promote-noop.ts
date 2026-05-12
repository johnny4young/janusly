/**
 * Two-pass AI generation — Pass 2: promote noop placeholders into
 * typed operator-only nodes.
 *
 * The generation route's Pass 1 emits a slim 11-type workflow. Some
 * intents (wait-for-time being the first wired) can't ship as real
 * typed nodes through the slim grammar so they land as `noop`
 * placeholders. Pass 2 detects those placeholders heuristically — by
 * id prefix, the most reliable signal the LLM consistently follows —
 * and re-prompts with a tight per-type single-shape schema to fill in
 * the runtime config. Each promotion is best-effort: a single LLM
 * throw, schema rejection, or unparseable duration is caught and the
 * offending noop stays unpromoted. Pass 1's overall workflow is always
 * returned intact.
 *
 * Why id-based detection: an earlier design asked the LLM to set
 * `config.promote: "wait_until"` + `config.hint: "<phrase>"` on noop
 * nodes. Empirically the model ignores that instruction and emits an
 * empty config — the path of least resistance. Operators consistently
 * see descriptive ids (`wait_3_days`, `sleep_12h`) for time-pause
 * placeholders, and the existing system prompt already encourages
 * snake_case descriptive ids, so the heuristic is reliable. The
 * operator's verbatim prompt is passed in as `originalPrompt` and used
 * as the Pass-2 hint, which means the LLM in Pass 2 sees the full
 * context (not a brittle snippet the Pass-1 model extracted).
 *
 * Rate-limit + cost posture: each promoted noop is one additional
 * Anthropic round-trip. The route-level `enforceRateLimit("ai", ...)`
 * gates the entry call only; Pass-2 calls are billed against the same
 * Redis bucket window but not individually capped. A workflow with N
 * wait-intent noops makes N+1 total LLM calls on a single
 * `/ai/generate-workflow` invocation.
 *
 * Used by `apps/api/src/routes/ai-routes.ts` between `generateObject`
 * and `sanitizeAiWorkflow` — the promoted workflow is then validated
 * by the engine's strict `WorkflowSchema` and the structural
 * `validateWorkflow` gate.
 */

import { parseIsoDuration, type Workflow, type WorkflowNode } from "@janusly/shared";
import type { LlmClient, LlmGenerateObjectInput } from "./llm-client";
import {
  AiWaitUntilConfigSchema,
  WAIT_UNTIL_PROMOTE_SYSTEM_PROMPT,
  type AiWaitUntilConfig,
} from "./promoted-schemas";

// The AI SDK's `Output.object` generic infers a deep instantiation when
// a Zod schema is passed directly, which trips TS2589 at the call site.
// Same boundary trick used by `suggest-improvement.ts` and
// `patch-workflow.ts`: cast through the input-type alias once at the
// chokepoint so the rest of the helper stays type-clean.
const WAIT_UNTIL_SCHEMA: LlmGenerateObjectInput<AiWaitUntilConfig>["schema"] =
  AiWaitUntilConfigSchema as unknown as LlmGenerateObjectInput<AiWaitUntilConfig>["schema"];

/** Telemetry context plumbed into each Pass-2 LLM call. Mirrors `LlmGenerateObjectInput.context`. */
export type PromoteNoopContext = {
  orgId: string;
  userId?: string;
  runId?: string;
  workflowId?: string;
};

/** Input for the Pass-2 promotion run. */
export type PromoteNoopInput = {
  /** Provider-resolved client. Pass-2 calls reuse the same provider/model the route already chose. */
  llm: LlmClient;
  /** Pass 1's workflow output, post-`generateObject`. Mutated functionally — input is not modified. */
  workflow: Workflow;
  /**
   * The operator's verbatim prompt from the route call. Used as the
   * Pass-2 hint so the LLM sees the full wait phrase in context (e.g.
   * "wait 3 days then call a webhook" rather than a Pass-1-extracted
   * snippet). The Pass-2 system prompt instructs the model to pluck
   * the duration relevant to the detected noop's id.
   */
  originalPrompt: string;
  /** Telemetry context; passed through to `llm.generateObject` for usage attribution. */
  context: PromoteNoopContext;
  /** Optional provider/model override (same `bare-id` or `provider/model` semantics as Pass 1). */
  modelHint?: string;
};

/** Outcome envelope returned to the route. */
export type PromoteNoopResult = {
  /** Workflow with any successfully-promoted noops flipped to typed nodes. */
  workflow: Workflow;
  /** Count of noops whose id matched a known promotion prefix. */
  promotionAttempts: number;
  /** Subset of attempts whose Pass-2 LLM call returned schema-valid config. */
  promotionsSucceeded: number;
};

/**
 * Closed list of id prefixes that mark a noop as a wait-intent
 * placeholder. The Pass-1 system prompt instructs the LLM to use these
 * conventions explicitly; the matcher is case-insensitive and accepts
 * any non-alphanumeric separator directly after the prefix, so
 * `wait_3_days` and `wait-30-min` surface while unrelated ids such as
 * `waiting_room` or `sleepy_customer` do not.
 */
const WAIT_ID_PREFIXES = ["wait", "sleep", "pause", "delay"];

function readPromoteTarget(node: WorkflowNode): "wait_until" | null {
  if (node.type !== "noop") return null;
  const id = node.id.toLowerCase();
  for (const prefix of WAIT_ID_PREFIXES) {
    if (id === prefix) return "wait_until";
    // Match `prefix_*`, `prefix-*`, or any non-alphanumeric separator.
    if (id.startsWith(prefix) && /[^a-z0-9]/.test(id.charAt(prefix.length))) return "wait_until";
  }
  return null;
}

/**
 * Pass-2 promoter for `wait_until`. Calls the LLM with the operator's
 * full original prompt, asks it to extract the duration relevant to
 * the detected noop id, and returns the typed config or `null` when
 * the model fails or rejects.
 */
async function promoteToWaitUntil(
  llm: LlmClient,
  node: WorkflowNode,
  originalPrompt: string,
  context: PromoteNoopContext,
  modelHint: string | undefined,
): Promise<{ duration: string } | null> {
  // An empty prompt means we can't extract anything useful — skip the
  // round-trip and leave the noop alone.
  if (originalPrompt.length === 0) return null;

  // Build a Pass-2 prompt that scopes the LLM to this specific noop.
  // The id (e.g. `wait_3_days`) is the strongest signal of what the
  // operator meant; the full prompt provides surrounding context.
  const userPrompt = [
    `Operator's full prompt: ${originalPrompt}`,
    `Target placeholder id: ${node.id}`,
    `Extract the ISO 8601 duration this placeholder represents.`,
  ].join("\n");

  try {
    const result = await llm.generateObject<AiWaitUntilConfig>({
      schema: WAIT_UNTIL_SCHEMA,
      system: WAIT_UNTIL_PROMOTE_SYSTEM_PROMPT,
      prompt: userPrompt,
      schemaName: "WaitUntilConfig",
      schemaDescription: "Strict ISO 8601 duration string for a wait_until node.",
      context,
      modelHint,
    });
    // Defense in depth: the schema already enforces a non-empty string,
    // but the model occasionally emits whitespace-only values that
    // satisfy `.min(1)` while still being useless. Trim + re-check.
    const duration = result.object?.duration?.trim?.() ?? "";
    const delayMs = parseIsoDuration(duration);
    if (duration.length === 0 || delayMs === null || delayMs <= 0) return null;
    return { duration };
  } catch {
    // The provider threw, schema validation failed, or the SDK couldn't
    // parse the response. All three collapse to "leave the noop alone".
    return null;
  }
}

/**
 * Walk the workflow's nodes and promote each one whose id matches a
 * known wait-intent prefix. Returns a new workflow object with promoted
 * nodes replaced; the original input is not mutated. Edges and
 * workflow-level fields pass through unchanged — promotion changes the
 * node's `type` and `config` only.
 */
export async function promoteNoopPlaceholders(
  input: PromoteNoopInput,
): Promise<PromoteNoopResult> {
  const { llm, workflow, originalPrompt, context, modelHint } = input;
  let promotionAttempts = 0;
  let promotionsSucceeded = 0;

  const promotedNodes: WorkflowNode[] = [];
  for (const node of workflow.nodes) {
    const target = readPromoteTarget(node);
    if (!target) {
      promotedNodes.push(node);
      continue;
    }

    promotionAttempts += 1;
    if (target === "wait_until") {
      const promotedConfig = await promoteToWaitUntil(llm, node, originalPrompt, context, modelHint);
      if (promotedConfig) {
        promotionsSucceeded += 1;
        promotedNodes.push({
          ...node,
          type: "wait_until",
          config: promotedConfig,
        });
        continue;
      }
    }
    // Per-noop failure — keep the original noop so the operator can
    // promote it manually in the Inspector.
    promotedNodes.push(node);
  }

  return {
    workflow: { ...workflow, nodes: promotedNodes },
    promotionAttempts,
    promotionsSucceeded,
  };
}
