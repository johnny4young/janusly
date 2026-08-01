/** External MCP client node executor and its timeline bridge. */

import { getOrgConfigSnapshot } from "@janusly/data";

import {
  executeMcpTool,
  readMcpClientWritesEnabled,
  resolveMcpClientRateLimitPerMin,
  resolveStdioSandboxConfig,
} from "../mcp-tool-executor";
import { appendEvent } from "../persistence";
import { mapInput } from "../template";
import type { NodeExecutorMap } from "./types";

export const mcpNodeExecutors = {
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
    const { connectionAlias, toolName, input, timeoutMs } = ctx.config;
    if (typeof connectionAlias !== "string" || !connectionAlias) {
      throw new Error("mcp_tool requires config.connectionAlias");
    }
    if (typeof toolName !== "string" || !toolName) {
      throw new Error("mcp_tool requires config.toolName");
    }

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
      timeoutMs,
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
} satisfies Pick<NodeExecutorMap, "mcp_tool">;
