/** Provider-neutral AI helpers used by workflow-node executors. */

import { createLlmClient, resolveLlmConfig, type LlmClient } from "@janusly/ai";
import {
  applyOrgConfigToEnv,
  getOrgConfigSnapshot,
  type OrgConfigSnapshot,
} from "@janusly/data";
import { WorkflowInputSchema } from "@janusly/shared";

import { validateInputs } from "../inputs-validator";

export function fallbackAiResponse(prompt: string, context: Record<string, any>) {
  const contextKeys = Object.keys(context).filter(key => !["orgId", "userId", "createdBy"].includes(key));
  return [
    "AI fallback response.",
    `Prompt: ${previewText(prompt)}`,
    contextKeys.length ? `Available context: ${contextKeys.join(", ")}.` : "No prior node context was available.",
    "Configure an LLM API key (OPENAI_API_KEY or ANTHROPIC_API_KEY) to generate a model-written answer.",
  ].join("\n");
}

export function previewText(value: string, maxLength = 700) {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

export function parseAiContractOutput(
  text: string,
  rawSchema: unknown,
): { ok: true; data: unknown } | { ok: false; error: string } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, error: "AI output was not valid JSON" };
  }

  const schema = WorkflowInputSchema.safeParse(rawSchema);
  if (!schema.success) return { ok: false, error: "AI output schema is invalid" };
  const validation = validateInputs(schema.data, data);
  if (!validation.valid) {
    return {
      ok: false,
      error: `AI output did not match its contract: ${validation.errors.join("; ")}`,
    };
  }
  return { ok: true, data };
}

export function createTenantLlmClient(orgConfig: OrgConfigSnapshot): LlmClient | null {
  const llmConfig = resolveLlmConfig(applyOrgConfigToEnv(orgConfig));
  return llmConfig ? createLlmClient(llmConfig) : null;
}

export async function getTenantLlmClient(orgId: string): Promise<LlmClient | null> {
  return createTenantLlmClient(await getOrgConfigSnapshot(orgId));
}
