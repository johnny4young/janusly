/**
 * Side-effect-free stable API contracts for the mcp domain.
 * Imported by route registries and the pure OpenAPI manifest.
 */

import { V1_MCP_PATHS } from "@janusly/shared/src/api-contract";
import { z } from "zod";

import type { ApiRouteContract } from "../api-contract-types";
import {
  MCP_CONNECTION_ERROR_CODES,
  MCP_WRITE_ERROR_CODES,
  McpConnectionPathSchema,
  McpConnectionSchema,
  McpConnectionToolPathSchema,
  McpCreateConnectionBodySchema,
  McpDiscoverySchema,
  McpSetToolBodySchema,
  McpToolDescriptorSchema,
  McpUpdateConnectionBodySchema,
} from "./schemas";

export const listMcpConnectionsContract = {
  operationId: "listMcpConnections",
  path: V1_MCP_PATHS.connections,
  summary: "List outbound MCP connections for the tenant",
  tags: ["MCP Connections"],
  response: z.object({
    connections: z.array(McpConnectionSchema.extend({
      toolCount: z.number().int().nonnegative(),
      enabledToolCount: z.number().int().nonnegative(),
    })),
  }),
  errorCodes: [],
} satisfies ApiRouteContract;

export const createMcpConnectionContract = {
  operationId: "createMcpConnection",
  path: V1_MCP_PATHS.connections,
  summary: "Register and discover an outbound MCP connection",
  tags: ["MCP Connections"],
  request: { body: McpCreateConnectionBodySchema },
  response: z.object({
    connection: McpConnectionSchema.nullable(),
    tools: z.array(McpToolDescriptorSchema),
    discovery: McpDiscoverySchema,
  }),
  errorCodes: [
    "invalid_input",
    "mcp_alias_invalid",
    "mcp_transport_invalid",
    "mcp_command_required",
    "mcp_command_allowlist_empty",
    "mcp_command_not_allowed",
    "mcp_url_required",
    "mcp_connection_duplicate",
    ...MCP_WRITE_ERROR_CODES,
  ],
} satisfies ApiRouteContract;

export const updateMcpConnectionContract = {
  operationId: "updateMcpConnection",
  path: V1_MCP_PATHS.connection,
  summary: "Update an outbound MCP connection",
  tags: ["MCP Connections"],
  request: {
    path: McpConnectionPathSchema,
    body: McpUpdateConnectionBodySchema,
  },
  response: McpConnectionSchema.nullable(),
  errorCodes: [
    "invalid_input",
    ...MCP_CONNECTION_ERROR_CODES,
    "mcp_url_invalid",
    "mcp_command_invalid",
    "mcp_command_not_allowed",
    "mcp_no_updatable_fields",
    ...MCP_WRITE_ERROR_CODES,
  ],
} satisfies ApiRouteContract;

export const deleteMcpConnectionContract = {
  operationId: "deleteMcpConnection",
  path: V1_MCP_PATHS.connection,
  summary: "Delete an outbound MCP connection",
  tags: ["MCP Connections"],
  request: { path: McpConnectionPathSchema },
  response: z.object({ ok: z.literal(true) }),
  errorCodes: ["invalid_input", ...MCP_CONNECTION_ERROR_CODES, ...MCP_WRITE_ERROR_CODES],
} satisfies ApiRouteContract;

export const rediscoverMcpConnectionContract = {
  operationId: "rediscoverMcpConnection",
  path: V1_MCP_PATHS.rediscoverConnection,
  summary: "Rediscover tools for an outbound MCP connection",
  tags: ["MCP Connections"],
  request: {
    path: McpConnectionPathSchema,
    body: z.object({}).strict(),
  },
  response: z.object({
    connection: McpConnectionSchema.nullable(),
    tools: z.array(McpToolDescriptorSchema),
    discovery: McpDiscoverySchema,
  }),
  errorCodes: [
    "invalid_input",
    ...MCP_CONNECTION_ERROR_CODES,
    "mcp_rate_limited",
    ...MCP_WRITE_ERROR_CODES,
  ],
} satisfies ApiRouteContract;

export const listMcpConnectionToolsContract = {
  operationId: "listMcpConnectionTools",
  path: V1_MCP_PATHS.connectionTools,
  summary: "List cached tools for an outbound MCP connection",
  tags: ["MCP Connections"],
  request: { path: McpConnectionPathSchema },
  response: z.object({ tools: z.array(McpToolDescriptorSchema) }),
  errorCodes: ["invalid_input", ...MCP_CONNECTION_ERROR_CODES],
} satisfies ApiRouteContract;

export const setMcpConnectionToolContract = {
  operationId: "setMcpConnectionTool",
  path: V1_MCP_PATHS.connectionTool,
  summary: "Update operator-controlled MCP tool flags",
  tags: ["MCP Connections"],
  request: {
    path: McpConnectionToolPathSchema,
    body: McpSetToolBodySchema,
  },
  response: McpToolDescriptorSchema.nullable(),
  errorCodes: [
    "invalid_input",
    ...MCP_CONNECTION_ERROR_CODES,
    "mcp_alias_tool_required",
    "mcp_tool_not_found",
    "mcp_rate_limit_invalid",
    "mcp_no_updatable_fields",
    ...MCP_WRITE_ERROR_CODES,
  ],
} satisfies ApiRouteContract;
