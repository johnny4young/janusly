/**
 * Shared preparation and dispatch helpers for registered workflow tools.
 *
 * Used by:
 * - `node-registry.ts` for ordinary `tool` nodes and agent-planner calls.
 * - `loop-executor.ts` for bounded per-item tool execution.
 *
 * Keeping HTTP tenant defaults and sandbox write classification here prevents
 * the three dispatch paths from drifting as new registered tools are added.
 */

import type { OrgConfigSnapshot } from "@janusly/data";
import { parseProviderSimulationReceipt } from "./local-integration-simulator";
import {
  isProviderSimulationToolInvocation,
} from "./provider-simulation-policy";
import { executeTool, isToolWriteSide } from "./tool-registry";
import {
  recordValidationProviderReceipt,
  type ValidationEffectMode,
} from "./validation-evidence";

export {
  isProviderSimulationRuntimeAvailable,
  isProviderSimulationToolInvocation,
} from "./provider-simulation-policy";

/** HTTP methods that read state without mutating it; safe in validation runs. */
export const SAFE_HTTP_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Apply the current tenant's bounded HTTP defaults to one tool invocation. */
export function withHttpToolDefaults(
  tool: string,
  input: unknown,
  orgConfig: OrgConfigSnapshot,
): unknown {
  if (tool !== "http.request" || typeof input !== "object" || input === null || Array.isArray(input)) {
    return input;
  }
  const next = { ...(input as Record<string, unknown>) };
  next.timeoutMs ??= orgConfig.http.timeoutMs;
  next.maxResponseBytes ??= orgConfig.http.maxResponseBytes;
  next.maxRedirects ??= orgConfig.http.maxRedirects;
  if (next.bodyMode === "stream") {
    next.streamPreviewBytes ??= orgConfig.http.streamPreviewBytes;
  }
  return next;
}

/**
 * Return the audit-safe reason an invocation must be skipped in validation
 * mode, or `null` when it is read-side and may execute.
 */
export function dryRunToolSkipPayload(
  tool: string,
  input: unknown,
  validationEffectMode: ValidationEffectMode = "skip",
): Record<string, unknown> | null {
  if (!isToolWriteSide(tool)) return null;
  const inputObj = (input ?? {}) as Record<string, unknown>;
  const method = typeof inputObj.method === "string" ? inputObj.method.toUpperCase() : "GET";
  const isHttpRead = tool === "http.request" && SAFE_HTTP_METHODS.has(method);
  if (isHttpRead) return null;
  if (
    validationEffectMode === "provider_simulation"
    && isProviderSimulationToolInvocation(tool, input)
  ) {
    return null;
  }
  return {
    reason: "write-side tool skipped in validation mode",
    tool,
    method: tool === "http.request" ? method : undefined,
  };
}

/** Conservative static write-side classification for timeout/replay gating. */
export function isToolInvocationWriteSide(tool: unknown, input: unknown): boolean {
  if (typeof tool !== "string" || !isToolWriteSide(tool)) return false;
  if (tool !== "http.request") return true;
  // A whole-object template (for example input="{{item}}") is not
  // classifiable until the item binds. Fail safe: only a structured object
  // with an absent method (the tool's GET default) or an explicit safe method
  // is read-side. Malformed/dynamic method values remain write-side.
  if (typeof input !== "object" || input === null || Array.isArray(input)) return true;
  const rawMethod = (input as Record<string, unknown>).method;
  if (rawMethod === undefined) return false;
  if (typeof rawMethod !== "string") return true;
  const method = rawMethod.toUpperCase();
  return !SAFE_HTTP_METHODS.has(method);
}

/** Execute one already-rendered tool input with the shared tenant context. */
export async function executeToolForRun(input: {
  tool: string;
  toolInput: unknown;
  context: Record<string, unknown>;
  orgConfig: OrgConfigSnapshot;
  orgId: string;
  runId: string;
  nodeId: string;
  workflowId?: string;
  validationEffectMode?: ValidationEffectMode;
}): Promise<Record<string, unknown>> {
  const providerSimulation = input.validationEffectMode === "provider_simulation"
    && isProviderSimulationToolInvocation(input.tool, input.toolInput);
  const result = await executeTool(input.tool, input.toolInput, input.context, {
    orgId: input.orgId,
    runId: input.runId,
    nodeId: input.nodeId,
    workflowId: input.workflowId,
    ...(providerSimulation ? { providerSimulation: { scope: "validation" as const } } : {}),
    email: input.orgConfig.email,
    integrations: input.orgConfig.integrations,
    objectstore: input.orgConfig.objectstore,
  });
  if (providerSimulation && result.ok === true) {
    const receipt = parseProviderSimulationReceipt(result.providerReceipt, "validation");
    if (!receipt) {
      throw new Error("Local provider simulation did not return a valid validation receipt");
    }
    await recordValidationProviderReceipt(
      input.runId,
      input.nodeId,
      input.tool,
      receipt,
    );
  }
  return result;
}
