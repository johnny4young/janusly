/** Provider-backed AI node executor with deterministic fallback behavior. */

import { appendEvent } from "../persistence";
import { resolvePromptRef } from "../prompt-resolver";
import { checkBudget } from "../budget";
import {
  fallbackAiResponse,
  getTenantLlmClient,
  parseAiContractOutput,
  previewText,
} from "./ai-shared";
import type { NodeExecutorMap } from "./types";

export const aiNodeExecutors = {
  /**
   * SDK, quota, and network errors must preserve the
   * `{ mode: "fallback", aiError, response }` envelope. Throwing here would
   * bypass the AI safety net and route an integration outage into retry/DLQ.
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
          ...(ctx.config.outputSchema !== undefined ? { valid: false } : {}),
        },
      };
    }

    // Budget chokepoint. The block path degrades to mode:"fallback" with
    // aiError:"budget_exceeded" so the workflow run continues to the next
    // node via the existing AI-fallback path.
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
          ...(ctx.config.outputSchema !== undefined ? { valid: false } : {}),
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
        responseFormat: ctx.config.outputSchema !== undefined
          ? "json"
          : ctx.config.responseFormat,
        modelHint,
        context: { orgId: ctx.orgId, runId: ctx.runId, nodeId: ctx.nodeId, workflowId: ctx.workflowId ?? undefined },
      });

      const contracted = ctx.config.outputSchema !== undefined
        ? parseAiContractOutput(result.text, ctx.config.outputSchema)
        : null;
      if (contracted && !contracted.ok) {
        await appendEvent(ctx.runId, ctx.nodeId, "ai.output_invalid", {
          error: contracted.error,
          model: result.model,
          provider: result.provider,
        });
        return {
          status: "completed",
          output: {
            mode: "fallback",
            valid: false,
            model: result.model,
            provider: result.provider,
            ...(result.providerSimulated
              ? { providerSimulated: true }
              : {}),
            modelHint,
            prompt: previewText(prompt),
            aiError: "output_invalid",
            error: contracted.error,
            response: fallbackAiResponse(String(prompt), ctx.context),
            usage: result.usage,
            costUsd: result.costUsd ?? null,
            latencyMs: result.latencyMs,
          },
        };
      }

      return {
        status: "completed",
        output: {
          mode: "ai",
          ...(contracted ? { valid: true, data: contracted.data } : {}),
          model: result.model,
          provider: result.provider,
          ...(result.providerSimulated
            ? { providerSimulated: true }
            : {}),
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
          ...(ctx.config.outputSchema !== undefined ? { valid: false } : {}),
        },
      };
    }
  },
} satisfies Pick<NodeExecutorMap, "ai">;
