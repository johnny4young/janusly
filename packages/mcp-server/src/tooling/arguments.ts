/** Strict MCP argument validation and connection payload projection. */

import { isObject } from "./shared";

const MCP_TRANSPORTS = ["stdio", "sse", "http"] as const;
const MCP_ALIAS_PATTERN = /^[a-z0-9_-]{1,32}$/;
const MCP_ENV_REF_KEY_PATTERN = /^(?:[a-z0-9_-]{1,32}|[A-Z][A-Z0-9_]{0,63})$/;

export function optionalInteger(
  value: unknown,
  label: string,
  min: number,
  max: number,
): number | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "number"
    || !Number.isInteger(value)
    || value < min
    || value > max
  ) {
    throw new Error(`${label} must be an integer between ${min} and ${max}`);
  }
  return value;
}

export function optionalString(
  value: unknown,
  label: string,
  maxLength: number,
  minLength = 1,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }
  const normalized = value.trim();
  if (normalized.length < minLength || normalized.length > maxLength) {
    throw new Error(`${label} must be ${minLength}-${maxLength} characters`);
  }
  return normalized;
}

export function requireString(
  value: unknown,
  label: string,
  maxLength = 512,
): string {
  const normalized = optionalString(value, label, maxLength);
  if (normalized === undefined) {
    throw new Error(`${label} is required`);
  }
  return normalized;
}

export function optionalEnum<T extends string>(
  value: unknown,
  label: string,
  allowed: readonly T[],
): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`${label} must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

export function optionalStringArray(
  value: unknown,
  label: string,
  maxItems: number,
  maxItemLength: number,
): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new Error(`${label} must be an array with at most ${maxItems} items`);
  }
  return value.map((item, index) =>
    requireString(item, `${label}[${index}]`, maxItemLength)
  );
}

export function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean`);
  }
  return value;
}

export function optionalEnvRefs(
  value: unknown,
  label: string,
): Record<string, { kind: "env"; name: string }> | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) {
    throw new Error(`${label} must be an object`);
  }
  const refs: Record<string, { kind: "env"; name: string }> = {};
  for (const [key, ref] of Object.entries(value)) {
    if (!MCP_ENV_REF_KEY_PATTERN.test(key) || !isObject(ref) || ref.kind !== "env") {
      throw new Error(`${label} contains an invalid environment reference`);
    }
    const unknownRefField = Object.keys(ref).find(
      (field) => field !== "kind" && field !== "name",
    );
    if (unknownRefField) {
      throw new Error(`${label}.${key} contains unknown field \`${unknownRefField}\``);
    }
    refs[key] = {
      kind: "env",
      name: requireString(ref.name, `${label}.${key}.name`, 128),
    };
  }
  return refs;
}

export function connectionCreatePayload(args: Record<string, unknown>): Record<string, unknown> {
  const alias = requireMcpAlias(args.alias, "mcp.connections.create");
  const transport = optionalEnum(
    args.transport,
    "mcp.connections.create `transport`",
    MCP_TRANSPORTS,
  );
  if (transport === undefined) {
    throw new Error("mcp.connections.create `transport` is required");
  }
  const payload: Record<string, unknown> = { alias, transport };
  const command = optionalString(args.command, "mcp.connections.create `command`", 512);
  const commandArgs = optionalStringArray(args.args, "mcp.connections.create `args`", 32, 200);
  const url = optionalString(args.url, "mcp.connections.create `url`", 2048);
  const envRefs = optionalEnvRefs(args.envRefs, "mcp.connections.create `envRefs`");
  if (command !== undefined) payload.command = command;
  if (commandArgs !== undefined) payload.args = commandArgs;
  if (url !== undefined) payload.url = url;
  if (envRefs !== undefined) payload.envRefs = envRefs;
  return payload;
}

export function connectionUpdatePayload(args: Record<string, unknown>): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  const enabled = optionalBoolean(args.enabled, "mcp.connections.update `enabled`");
  const exposeToAi = optionalBoolean(args.exposeToAi, "mcp.connections.update `exposeToAi`");
  const command = optionalString(args.command, "mcp.connections.update `command`", 512);
  const commandArgs = optionalStringArray(args.args, "mcp.connections.update `args`", 32, 200);
  const url = optionalString(args.url, "mcp.connections.update `url`", 2048);
  const envRefs = optionalEnvRefs(args.envRefs, "mcp.connections.update `envRefs`");
  if (enabled !== undefined) payload.enabled = enabled;
  if (exposeToAi !== undefined) payload.exposeToAi = exposeToAi;
  if (command !== undefined) payload.command = command;
  if (commandArgs !== undefined) payload.args = commandArgs;
  if (url !== undefined) payload.url = url;
  if (envRefs !== undefined) payload.envRefs = envRefs;
  if (Object.keys(payload).length === 0) {
    throw new Error("mcp.connections.update requires at least one field to update");
  }
  return payload;
}

export function mcpToolPatchPayload(args: Record<string, unknown>): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  const enabled = optionalBoolean(args.enabled, "mcp.connections.set_tool `enabled`");
  const writeSide = optionalBoolean(args.writeSide, "mcp.connections.set_tool `writeSide`");
  const exposeToAi = optionalBoolean(args.exposeToAi, "mcp.connections.set_tool `exposeToAi`");
  if (enabled !== undefined) payload.enabled = enabled;
  if (writeSide !== undefined) payload.writeSide = writeSide;
  if (exposeToAi !== undefined) payload.exposeToAi = exposeToAi;
  if (args.rateLimitPerMin === null) {
    payload.rateLimitPerMin = null;
  } else {
    const rateLimit = optionalInteger(
      args.rateLimitPerMin,
      "mcp.connections.set_tool `rateLimitPerMin`",
      1,
      10_000,
    );
    if (rateLimit !== undefined) payload.rateLimitPerMin = rateLimit;
  }
  if (Object.keys(payload).length === 0) {
    throw new Error("mcp.connections.set_tool requires at least one field to update");
  }
  return payload;
}

export function requireMcpAlias(value: unknown, toolName: string): string {
  if (typeof value === "string" && MCP_ALIAS_PATTERN.test(value)) return value;
  throw new Error(`${toolName} requires \`alias\` matching /^[a-z0-9_-]{1,32}$/`);
}

export function requireMcpToolName(value: unknown): string {
  if (typeof value === "string") {
    const normalized = value.trim();
    if (normalized.length > 0 && normalized.length <= 512) return normalized;
  }
  throw new Error("mcp.connections.set_tool requires `toolName` (1-512 characters)");
}
