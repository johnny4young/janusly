/** API translation for MCP operations protected by write consent. */

import { V1_MCP_PATHS, V1_WRITE_PATHS } from "@janusly/shared/src/api-contract";
import type { CallApi } from "../api-client";
import {
  connectionCreatePayload,
  connectionUpdatePayload,
  mcpToolPatchPayload,
  optionalBoolean,
  optionalEnum,
  optionalString,
  requireMcpAlias,
  requireMcpToolName,
  requireString,
} from "./arguments";
import { mcpWritesEnabled } from "./catalog";
import { isObject, v1 } from "./shared";

export async function dispatchWriteTool(
  callApi: CallApi,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case "runs.start": {
      requireWrites(name);
      if (!isObject(args.workflow)) {
        throw new Error("runs.start requires `workflow` (object)");
      }
      const payload: Record<string, unknown> = { workflow: args.workflow };
      if (args.input !== undefined) payload.input = args.input;
      return callApi(v1(V1_WRITE_PATHS.startRun), {
        method: "POST",
        body: JSON.stringify(payload),
      });
    }
    case "runs.resume": {
      requireWrites(name);
      const runId = requireString(args.runId, "runs.resume `runId`", 256);
      const nodeId = requireString(args.nodeId, "runs.resume `nodeId`", 256);
      const payload: Record<string, unknown> = { runId, nodeId };
      if (args.input !== undefined) payload.input = args.input;
      const resumeToken = optionalString(
        args.resumeToken,
        "runs.resume `resumeToken`",
        8192,
      );
      if (resumeToken !== undefined) payload.resumeToken = resumeToken;
      return callApi(v1(V1_WRITE_PATHS.resumeRun), {
        method: "POST",
        body: JSON.stringify(payload),
      });
    }
    case "runs.redrive": {
      requireWrites(name);
      const runId = requireString(args.runId, "runs.redrive `runId`", 256);
      const payload: Record<string, unknown> = { runId };
      const nodeId = optionalString(args.nodeId, "runs.redrive `nodeId`", 256);
      if (nodeId !== undefined) payload.nodeId = nodeId;
      const workflowVersionId = optionalString(
        args.workflowVersionId,
        "runs.redrive `workflowVersionId`",
        256,
      );
      if (workflowVersionId !== undefined) {
        payload.workflowVersionId = workflowVersionId;
      }
      return callApi(v1(V1_WRITE_PATHS.redriveRun), {
        method: "POST",
        body: JSON.stringify(payload),
      });
    }
    case "runs.cancel": {
      requireWrites(name);
      const runId = requireString(args.runId, "runs.cancel `runId`", 256);
      const payload: Record<string, unknown> = { runId };
      const reason = optionalString(args.reason, "runs.cancel `reason`", 1000);
      if (reason !== undefined) payload.reason = reason;
      return callApi(v1(V1_WRITE_PATHS.cancelRun), {
        method: "POST",
        body: JSON.stringify(payload),
      });
    }
    case "dlq.replay": {
      requireWrites(name);
      const deadLetterId = requireString(args.deadLetterId, "dlq.replay `deadLetterId`", 256);
      return callApi(v1(V1_WRITE_PATHS.replayDeadLetter), {
        method: "POST",
        body: JSON.stringify({ deadLetterId }),
      });
    }
    case "recovery.cases.resolve": {
      requireWrites(name);
      const caseId = requireString(
        args.caseId,
        "recovery.cases.resolve `caseId`",
        256,
      );
      const decision = optionalEnum(
        args.decision,
        "recovery.cases.resolve `decision`",
        ["replace", "accept_loss"] as const,
      );
      if (decision === undefined) {
        throw new Error(
          "recovery.cases.resolve `decision` is required",
        );
      }
      const reason = requireString(
        args.reason,
        "recovery.cases.resolve `reason`",
        1000,
      );
      const payload: Record<string, unknown> = { decision, reason };
      if (decision === "replace") {
        if (args.output === undefined) {
          throw new Error(
            "recovery.cases.resolve `output` is required for `replace`",
          );
        }
        payload.output = args.output;
      }
      return callApi(
        v1(V1_WRITE_PATHS.recoverSemanticCase)
          .replace("{caseId}", encodeURIComponent(caseId)),
        {
          method: "POST",
          body: JSON.stringify(payload),
        },
      );
    }
    case "workflows.rollback": {
      requireWrites(name);
      const workflowId = requireString(args.workflowId, "workflows.rollback `workflowId`");
      const sourceVersionId = requireString(
        args.sourceVersionId,
        "workflows.rollback `sourceVersionId`",
      );
      return callApi(v1(V1_WRITE_PATHS.rollbackWorkflow), {
        method: "POST",
        body: JSON.stringify({ workflowId, sourceVersionId }),
      });
    }
    case "workflows.resume": {
      requireWrites(name);
      const workflowId = requireString(
        args.workflowId,
        "workflows.resume `workflowId`",
      );
      return callApi(
        v1(V1_WRITE_PATHS.resumeWorkflow)
          .replace("{workflowId}", encodeURIComponent(workflowId)),
        { method: "POST", body: "{}" },
      );
    }
    case "mcp.connections.create": {
      requireWrites(name);
      return callApi(v1(V1_MCP_PATHS.connections), {
        method: "POST",
        body: JSON.stringify(connectionCreatePayload(args)),
      });
    }
    case "mcp.connections.update": {
      requireWrites(name);
      const alias = requireMcpAlias(args.alias, name);
      const patch = connectionUpdatePayload(args);
      return callApi(
        v1(V1_MCP_PATHS.connection).replace("{alias}", encodeURIComponent(alias)),
        { method: "POST", body: JSON.stringify(patch) },
      );
    }
    case "mcp.connections.rediscover": {
      requireWrites(name);
      const alias = requireMcpAlias(args.alias, name);
      return callApi(v1(V1_MCP_PATHS.rediscoverConnection)
        .replace("{alias}", encodeURIComponent(alias)), {
        method: "POST",
        body: "{}",
      });
    }
    case "mcp.connections.set_tool": {
      requireWrites(name);
      const alias = requireMcpAlias(args.alias, name);
      const toolName = requireMcpToolName(args.toolName);
      const patch = mcpToolPatchPayload(args);
      return callApi(
        v1(V1_MCP_PATHS.connectionTool)
          .replace("{alias}", encodeURIComponent(alias))
          .replace("{toolName}", encodeURIComponent(toolName)),
        { method: "POST", body: JSON.stringify(patch) },
      );
    }
    case "mcp.connections.delete": {
      requireWrites(name);
      const alias = requireMcpAlias(args.alias, name);
      return callApi(
        v1(V1_MCP_PATHS.connection).replace("{alias}", encodeURIComponent(alias)),
        { method: "DELETE" },
      );
    }
    case "workflows.save": {
      requireWrites(name);
      if (!isObject(args.workflow)) {
        throw new Error("workflows.save requires `workflow` (object)");
      }
      const dryRun = optionalBoolean(args.dryRun, "workflows.save `dryRun`");
      if (dryRun === true) {
        const validation = await callApi(v1(V1_WRITE_PATHS.validateWorkflow), {
          method: "POST",
          body: JSON.stringify(args.workflow),
        });
        return {
          mode: "dry-run",
          ...(isObject(validation) ? validation : { validation }),
        };
      }
      return callApi(v1(V1_WRITE_PATHS.saveWorkflow), {
        method: "POST",
        body: JSON.stringify(args.workflow),
      });
    }
    default:
      throw new Error(`Unknown write MCP tool: ${name}`);
  }
}

/** Defense-in-depth for clients that invoke a non-advertised write. */
function requireWrites(name: string): void {
  if (!mcpWritesEnabled()) {
    throw new Error(`${name} is disabled (set JANUSLY_MCP_WRITES_ENABLED=true to advertise)`);
  }
}
