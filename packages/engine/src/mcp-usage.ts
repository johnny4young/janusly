/**
 * Process-global recorder for MCP-client tool usage telemetry. Sister
 * to `integration-usage.ts`: at process boot, the api + worker call
 * `setMcpUsageRecorder(recordMcpUsage)`. Every `mcp_tool` node call
 * (success OR failure — rate-limit reject, timeout, missing env-ref,
 * tool error, etc.) fires the recorder fire-and-forget. Recorder
 * failures are caught + dropped; telemetry must never break a tool
 * path (mirrors the AI fallback contract).
 *
 * The DB write lives in `packages/data/src/usageRepo.ts:recordMcpUsage`.
 * This module is the seam that lets `packages/engine` stay DB-agnostic
 * for MCP client work — zero `@janusly/db` imports.
 *
 * Used by:
 * - `apps/api/src/index.ts` — boot path: `setMcpUsageRecorder(recordMcpUsage)`.
 * - `packages/engine/src/worker.ts` — boot path: same.
 * - `packages/engine/src/mcp-tool-executor.ts` — fires the recorder.
 *
 * Invariants:
 * - Multi-tenant scope: every record carries `orgId`.
 * - The recorder is process-global; never install one per request.
 */

export type McpUsageRecord = {
  /** Multi-tenant scope. Required. */
  orgId: string;
  /** Alias the connection was registered under (e.g. "stripe-prod"). */
  connectionAlias: string;
  /** Tool name on the external MCP server (e.g. "create_charge"). */
  toolName: string;
  /** Transport used for this call. */
  transport: "stdio" | "sse" | "http";
  /** Workflow run id when the call fired from an `mcp_tool` node. */
  runId?: string;
  /** Workflow node id when the call fired from an `mcp_tool` node. */
  nodeId?: string;
  /** Saved-workflow id (for the `?breakdown=workflow` axis). */
  workflowId?: string;
  ok: boolean;
  /** Generic error string. Never the env-var name of a missing secret. */
  error?: string;
  /** Wall-clock latency from the executor's POV (ms). */
  latencyMs: number;
  /** True when the tool was flagged write-side at descriptor time. */
  writeSide: boolean;
};

/** Sync or async — the executor awaits the returned promise inside its own try/catch. */
export type McpUsageRecorder = (record: McpUsageRecord) => void | Promise<void>;

let recorder: McpUsageRecorder | null = null;

/** Register the process-global MCP-usage recorder. Pass `null` to disable. */
export function setMcpUsageRecorder(fn: McpUsageRecorder | null): void {
  recorder = fn;
}

/** Inspect the currently registered recorder. */
export function getMcpUsageRecorder(): McpUsageRecorder | null {
  return recorder;
}

/** Reset the registry. Tests that mutate it between cases call this. */
export function _resetMcpUsageRecorderForTests(): void {
  recorder = null;
}
