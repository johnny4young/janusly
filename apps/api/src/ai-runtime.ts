/**
 * Per-tenant LLM client construction + the AI-mutation invariants every
 * AI route shares: post-Zod sanitization for `/ai/generate-workflow`,
 * fallback workflow / explanation builders for the AI-fallback contract,
 * and the decision-replay candidate parser used by `/causal`.
 *
 * Used by `apps/api/src/routes/ai-routes.ts`,
 * `apps/api/src/routes/runs-routes.ts` (causal replay), and
 * `apps/api/src/routes/dlq-routes.ts` (sandbox replay sanitization).
 *
 * Invariants:
 * - `sanitizeAiWorkflow` runs after every AI mutation that emits a
 *   workflow. The engine's expression evaluator is stricter than Zod's
 *   `z.string()`; bypassing this lets a valid-shaped-but-runtime-
 *   invalid workflow reach persistence.
 * - The fallback helpers are the deterministic side of the AI-fallback
 *   contract: every AI route degrades to one of these on quota / rate /
 *   network / bad-output failures.
 */

import { createLlmClient, resolveLlmConfig } from "@janusly/ai";
import {
  applyOrgConfigToEnv,
  getOrgConfigSnapshot,
} from "@janusly/data";
import type { DecisionCandidate } from "@janusly/domain";
import { validateExpression } from "@janusly/engine/src/expression";
import { validateWorkflow } from "@janusly/engine/src/workflow-validation";
import { WorkflowSchema, type Workflow } from "@janusly/shared";

import { httpError, asNumber, asRecord } from "./http";
import { workflowTemplates } from "./templates";

export async function orgLlmRuntime(orgId: string) {
  const orgConfig = await getOrgConfigSnapshot(orgId);
  const llmConfig = resolveLlmConfig(applyOrgConfigToEnv(orgConfig));
  return { orgConfig, llm: llmConfig ? createLlmClient(llmConfig) : null, llmConfig };
}

export async function aiStatus(orgId: string) {
  // Env still provides API keys and global defaults; `org_configs` can
  // override safe tenant-level choices such as provider/model and limits.
  const { orgConfig, llmConfig } = await orgLlmRuntime(orgId);
  const provider = llmConfig?.provider ?? orgConfig.ai.provider;
  const model =
    llmConfig?.defaultModels[provider] ??
    (provider === "anthropic" ? orgConfig.ai.anthropicModel : orgConfig.ai.openaiModel);
  return {
    enabled: Boolean(llmConfig?.apiKeys[provider]),
    provider,
    model,
    timeoutMs: orgConfig.ai.timeoutMs,
    maxRetries: orgConfig.ai.maxRetries,
  };
}

/**
 * Post-Zod sanitization for `/ai/generate-workflow` (and any other
 * AI mutation that emits a workflow). The LLM-emitted workflow has
 * already been validated against the AI generation subset by the
 * SDK's structured-output path; this step filters edge `condition`
 * strings and `condition`-node expressions through `validateExpression`
 * (Janusly's limited grammar), then runs the full engine
 * `validateWorkflow` gate. Without this, valid-shaped-but-runtime-
 * invalid output would crash at execution time instead of degrading
 * to fallback.
 */
export function sanitizeAiWorkflow(workflow: Workflow): Workflow {
  const sanitizedEdges = workflow.edges.map((edge) => {
    if (!edge.condition) return edge;
    return validateExpression(edge.condition).valid ? edge : { ...edge, condition: undefined };
  });
  const sanitizedNodes = workflow.nodes.map((node) => {
    // Draft-generation tolerance for under-specified `transform` nodes.
    // The AI generation subset (`AiTransformNode`) permits an empty
    // `config.mapping` ({}), but the engine's strict `validateWorkflow`
    // rejects it (`transform_missing_mapping`). The LLM intermittently
    // emits exactly that — a `transform` step it hasn't filled in yet —
    // which pre-fix discarded the ENTIRE draft to a fallback template
    // (observed on ~2/3 "loop over a list and collect" generations).
    // Demote the unfilled node to a `noop` placeholder so the rest of
    // the draft survives and the operator completes the mapping in the
    // Inspector — same posture as the partial-tool-input tolerance below
    // and the operator-only noop-placeholder convention AI generation
    // already uses for the 9 node types outside the grammar.
    if (node.type === "transform") {
      const mapping = (node.config as { mapping?: unknown } | undefined)?.mapping;
      const hasMapping =
        !!mapping &&
        typeof mapping === "object" &&
        !Array.isArray(mapping) &&
        Object.keys(mapping as Record<string, unknown>).length > 0;
      if (!hasMapping) return { ...node, type: "noop" as const, config: {} };
      return node;
    }
    if (node.type !== "condition") return node;
    const expression = node.config && typeof (node.config as { expression?: unknown }).expression === "string"
      ? String((node.config as { expression: string }).expression)
      : "";
    if (expression && !validateExpression(expression).valid) {
      return { ...node, config: { ...(node.config ?? {}), expression: "true" } };
    }
    return node;
  });
  const sanitized = { ...workflow, nodes: sanitizedNodes, edges: sanitizedEdges };

  // Draft-generation tolerance: AI-emitted `tool` nodes may carry
  // partial `input` because the operator finishes the rest in the
  // Inspector. The strict consumption surfaces (`/start`, `/save`,
  // `/validate`, `/workflows/readiness`, the web pre-save check) keep
  // the default `strictToolInputs: true` and reject incomplete inputs
  // at run / save / preflight time. Without this carve-out every
  // tool-using prompt silently fell back to a fixture template
  // because the schema couldn't even carry partial inputs.
  const validation = validateWorkflow(sanitized, { strictToolInputs: false });
  if (!validation.valid) {
    throw httpError(`AI returned a workflow with validation issues: ${validation.issues.map(issue => issue.message).join(", ")}`, 502);
  }

  return sanitized;
}

const stepLabels: Record<string, string> = {
  http: "Call an API",
  noop: "Do nothing",
  transform: "Shape data",
  condition: "Branch rule",
  webhook: "Wait for webhook",
  approval: "Ask approval",
  human_form: "Collect form",
  ai: "AI prompt",
  tool: "Run a tool",
  agent: "Agent",
  router: "Smart router",
  router_llm: "AI router",
  loop: "Repeat list",
  agent_reflection: "Review result",
  multi_agent: "Agent team",
};

export function fallbackExplainWorkflow(workflow: unknown) {
  const parsed = WorkflowSchema.safeParse(workflow);
  if (!parsed.success) {
    return "Janusly could not read this flow yet. Check that it has valid steps and paths.";
  }

  const data = parsed.data;
  const labelFor = (nodeId: string) => {
    const node = data.nodes.find(candidate => candidate.id === nodeId);
    return node ? stepLabels[node.type] ?? node.type.replaceAll("_", " ") : nodeId;
  };
  const incoming = new Set(data.edges.map(edge => edge.to));
  const startNodes = data.nodes.filter(node => !incoming.has(node.id)).map(node => labelFor(node.id));
  const nodeNames = data.nodes.map(node => `- ${stepLabels[node.type] ?? node.type.replaceAll("_", " ")} (${node.id})`).join("\n");
  const flow = data.edges.length
    ? data.edges.map(edge => `${labelFor(edge.from)} -> ${labelFor(edge.to)}${edge.condition ? " when the rule passes" : ""}`).join("\n")
    : "No paths yet; this flow has one or more standalone steps.";

  return [
    `${data.name ?? data.id ?? "This flow"} has ${data.nodes.length} step${data.nodes.length === 1 ? "" : "s"}.`,
    `It starts with: ${startNodes.length ? startNodes.join(", ") : "no clear start step"}.`,
    `Steps:\n${nodeNames || "none"}`,
    `Path:\n${flow}`,
    "Next check: validate the flow, run it, then ask Janusly what happened.",
  ].join("\n");
}

export function fallbackWorkflowForPrompt(prompt: unknown) {
  const text = typeof prompt === "string" ? prompt.toLowerCase() : "";
  // Email-shape matcher runs FIRST so a prompt like "respond to incidents
  // by email" lands on the email skeleton instead of the incident webhook
  // template — the operator's intent (send a reply) is closer to the
  // email shape than the incident shape.
  const templateId = text.includes("email") || text.includes("correo") || text.includes("gmail") || text.includes("mail")
    ? "email-reply"
    : text.includes("incident") || text.includes("on-call") || text.includes("slack") || text.includes("github")
    ? "incident-triage"
    : text.includes("approval") || text.includes("approve") || text.includes("aprob") || text.includes("human") || text.includes("risk")
    ? "approval-gate"
    : text.includes("transform") || text.includes("map") || text.includes("tool") || text.includes("herramient") || text.includes("backend")
      ? "api-transform-tool"
      : "http-ai-summary";

  return workflowTemplates.find(template => template.id === templateId)?.workflow ?? workflowTemplates[0]?.workflow;
}

export function decisionCandidatesFromPayload(payload: unknown): DecisionCandidate[] {
  const record = asRecord(payload);
  const ranking = Array.isArray(record.ranking) ? record.ranking : [];

  return ranking.flatMap(item => {
    const candidate = asRecord(item);
    const breakdown = asRecord(candidate.breakdown);
    const nodeId = typeof candidate.nodeId === "string" ? candidate.nodeId : "";
    if (!nodeId) return [];

    return [{
      nodeId,
      avgCost: asNumber(breakdown.cost),
      avgLatencyMs: asNumber(breakdown.latency),
      successRate: asNumber(breakdown.quality),
    }];
  });
}
