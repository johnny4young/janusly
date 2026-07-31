/** MCP protocol result projection and API dispatcher composition. */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  JanuslyApiError,
  JanuslyProtocolError,
  type CallApi,
} from "../api-client";
import { WRITE_TOOLS } from "./write-tools";
import { ALWAYS_VISIBLE_TOOLS } from "./visible-tools";
import { dispatchVisibleTool } from "./dispatch-visible";
import { dispatchWriteTool } from "./dispatch-write";

/** Dispatch one validated MCP operation and expose text plus structured content. */
export async function dispatchTool(
  callApi: CallApi,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  assertKnownArguments(name, args);
  const isWrite = WRITE_TOOLS.some((tool) => tool.name === name);
  const json = isWrite
    ? await dispatchWriteTool(callApi, name, args)
    : await dispatchVisibleTool(callApi, name, args);
  const result = json === undefined ? null : json;
  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    structuredContent: { result },
  };
}

function assertKnownArguments(name: string, args: Record<string, unknown>): void {
  const descriptor = [...ALWAYS_VISIBLE_TOOLS, ...WRITE_TOOLS]
    .find((tool) => tool.name === name);
  if (!descriptor) throw new Error(`Unknown MCP tool: ${name}`);

  const properties = descriptor.inputSchema.properties ?? {};
  for (const key of Object.keys(args)) {
    if (!Object.hasOwn(properties, key)) {
      throw new Error(`${name} received unknown argument \`${key}\``);
    }
  }
}

/** Keep expected API and argument failures inside the MCP tool loop. */
export function toolErrorResult(error: unknown): CallToolResult {
  const detail = normalizeToolError(error);
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(detail, null, 2) }],
    structuredContent: { result: detail },
  };
}

function normalizeToolError(error: unknown): Record<string, unknown> {
  if (error instanceof JanuslyApiError) {
    return {
      ok: false,
      error: {
        message: error.message,
        code: error.code ?? "janusly_api_error",
        status: error.status,
        ...(error.requestId ? { requestId: error.requestId } : {}),
        ...(error.params ? { params: error.params } : {}),
      },
    };
  }
  if (error instanceof JanuslyProtocolError) {
    return {
      ok: false,
      error: {
        message: error.message,
        code: "janusly_protocol_error",
      },
    };
  }
  return {
    ok: false,
    error: {
      message: error instanceof Error ? error.message : "Tool call failed",
      code: "mcp_tool_error",
    },
  };
}
