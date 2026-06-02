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
  AiScheduleConfigSchema,
  AiWaitUntilConfigSchema,
  CRON_EXPRESSION_PATTERN,
  SCHEDULE_PROMOTE_SYSTEM_PROMPT,
  WAIT_UNTIL_PROMOTE_SYSTEM_PROMPT,
  isEngineCompatibleCronExpression,
  type AiScheduleConfig,
  type AiWaitUntilConfig,
} from "./promoted-schemas";

// The AI SDK's `Output.object` generic infers a deep instantiation when
// a Zod schema is passed directly, which trips TS2589 at the call site.
// Same boundary trick used by `suggest-improvement.ts` and
// `patch-workflow.ts`: cast through the input-type alias once at the
// chokepoint so the rest of the helper stays type-clean.
const WAIT_UNTIL_SCHEMA: LlmGenerateObjectInput<AiWaitUntilConfig>["schema"] =
  AiWaitUntilConfigSchema as unknown as LlmGenerateObjectInput<AiWaitUntilConfig>["schema"];
const SCHEDULE_SCHEMA: LlmGenerateObjectInput<AiScheduleConfig>["schema"] =
  AiScheduleConfigSchema as unknown as LlmGenerateObjectInput<AiScheduleConfig>["schema"];

/** Closed enum of promotion target node types. Adding one means a new family entry + a new dispatcher branch. */
export type PromoteTarget = "wait_until" | "schedule";

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

/** Per-family promotion counters. Used by the route audit to surface
 *  which intent families the LLM tagged and how many actually landed. */
export type PromotionFamilyCounts = { attempts: number; succeeded: number };
export type PromotionsByFamily = Record<PromoteTarget, PromotionFamilyCounts>;

/** Outcome envelope returned to the route. */
export type PromoteNoopResult = {
  /** Workflow with any successfully-promoted noops flipped to typed nodes. */
  workflow: Workflow;
  /** Count of noops whose id matched ANY known promotion prefix (sum across families). */
  promotionAttempts: number;
  /** Subset of attempts whose Pass-2 LLM call returned schema-valid config. */
  promotionsSucceeded: number;
  /**
   * Per-family breakdown of the same totals — keys are the promotion
   * target node types (`wait_until`, `schedule`, …). Operators read
   * this from `audit_logs.metadata.promotionsByFamily` to see which
   * intent families the model actually exercised.
   */
  promotionsByFamily: PromotionsByFamily;
};

/**
 * Closed list of promotion families. Each entry pairs an id-prefix
 * set with a typed target node type. The Pass-1 system prompt teaches
 * the LLM the conventions explicitly; this matcher is case-insensitive
 * and accepts any non-alphanumeric separator directly after the
 * prefix, so `wait_3_days`, `wait-30-min`, `schedule_daily`, and
 * `every_monday` all surface while unrelated ids such as
 * `waiting_room`, `sleepy_customer`, or `analyze_wait_time` do not.
 *
 * Adding a new family is one new entry here plus a `case` in the
 * promoter dispatcher inside `promoteNoopPlaceholders`.
 */
export const PROMOTE_FAMILIES: ReadonlyArray<{ prefixes: readonly string[]; target: PromoteTarget }> = [
  {
    target: "wait_until",
    prefixes: ["wait", "sleep", "pause", "delay"],
  },
  {
    target: "schedule",
    // `schedule_*`, `cron_*`, and natural cadence words operators commonly
    // use as placeholder ids when describing a recurring step.
    prefixes: ["schedule", "cron", "every", "daily", "weekly", "monthly", "hourly"],
  },
];

function readPromoteTarget(node: WorkflowNode): PromoteTarget | null {
  if (node.type !== "noop") return null;
  const id = node.id.toLowerCase();
  for (const family of PROMOTE_FAMILIES) {
    for (const prefix of family.prefixes) {
      if (id === prefix) return family.target;
      // Match `prefix_*`, `prefix-*`, or any non-alphanumeric separator.
      if (id.startsWith(prefix) && /[^a-z0-9]/.test(id.charAt(prefix.length))) return family.target;
    }
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
 * Pass-2 promoter for `schedule`. Calls the LLM with the operator's
 * full original prompt and the noop's id, asks it to extract a
 * standard 5-field cron expression, and returns the typed config or
 * `null` when the model fails or rejects. v1 mirrors `promoteToWaitUntil`
 * exactly — single LLM call, schema-validated output, silent degrade.
 */
async function promoteToSchedule(
  llm: LlmClient,
  node: WorkflowNode,
  originalPrompt: string,
  context: PromoteNoopContext,
  modelHint: string | undefined,
): Promise<{ cronExpression: string } | null> {
  if (originalPrompt.length === 0) return null;

  const userPrompt = [
    `Operator's full prompt: ${originalPrompt}`,
    `Target placeholder id: ${node.id}`,
    `Extract the standard 5-field cron expression this placeholder represents.`,
  ].join("\n");

  try {
    const result = await llm.generateObject<AiScheduleConfig>({
      schema: SCHEDULE_SCHEMA,
      system: SCHEDULE_PROMOTE_SYSTEM_PROMPT,
      prompt: userPrompt,
      schemaName: "ScheduleConfig",
      schemaDescription: "Standard 5-field cron expression for a schedule node.",
      context,
      modelHint,
    });
    const cronExpression = result.object?.cronExpression?.trim?.() ?? "";
    // Defense in depth: keep malformed cron output local to this
    // placeholder so `sanitizeAiWorkflow` does not have to downgrade
    // the entire generation response to fallback.
    if (cronExpression.length === 0) return null;
    if (!CRON_EXPRESSION_PATTERN.test(cronExpression)) return null;
    if (!isEngineCompatibleCronExpression(cronExpression)) return null;
    return { cronExpression };
  } catch {
    return null;
  }
}

/**
 * Walk the workflow's nodes and promote each one whose id matches a
 * known intent prefix. Returns a new workflow object with promoted
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
  const promotionsByFamily: PromotionsByFamily = {
    wait_until: { attempts: 0, succeeded: 0 },
    schedule: { attempts: 0, succeeded: 0 },
  };

  const promotedNodes: WorkflowNode[] = [];
  for (const node of workflow.nodes) {
    const target = readPromoteTarget(node);
    if (!target) {
      promotedNodes.push(node);
      continue;
    }

    promotionAttempts += 1;
    promotionsByFamily[target].attempts += 1;
    if (target === "wait_until") {
      const promotedConfig = await promoteToWaitUntil(llm, node, originalPrompt, context, modelHint);
      if (promotedConfig) {
        promotionsSucceeded += 1;
        promotionsByFamily.wait_until.succeeded += 1;
        promotedNodes.push({
          ...node,
          type: "wait_until",
          config: promotedConfig,
        });
        continue;
      }
    } else if (target === "schedule") {
      const promotedConfig = await promoteToSchedule(llm, node, originalPrompt, context, modelHint);
      if (promotedConfig) {
        promotionsSucceeded += 1;
        promotionsByFamily.schedule.succeeded += 1;
        promotedNodes.push({
          ...node,
          type: "schedule",
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
    promotionsByFamily,
  };
}
