/**
 * Event-driven trigger node executors + config resolution.
 *
 * Four trigger node types (`webhook_received`, `email_received`,
 * `file_dropped`, `mcp_server_event`) extend the runtime's trigger surface
 * alongside `schedule`. Like `schedule`, they are PASSTHROUGH triggers: the actual
 * firing happens outside the executor — the API ingestion seam
 * (`apps/api/src/routes/trigger-ingest-routes.ts`) accepts a normalized
 * inbound payload, persists a structured `trigger_events` row (the
 * DLQ-style replay anchor), applies a per-trigger rate-limit storm guard,
 * and spawns a run via `startRun` with the normalized event as the run
 * input. The executor itself just succeeds with `{ triggeredBy, event }`
 * so downstream nodes / templates can read the inbound data
 * (e.g. `{{context.inbox.output.event.from}}`).
 *
 * Manual `POST /start` against a workflow whose first node is a trigger
 * still runs (and downstream nodes execute) with an empty event — that's
 * intentional: manual start is a separate trigger surface, same as the
 * `schedule` executor's documented behaviour.
 *
 * Used by:
 * - `node-registry.ts` — registers the trigger executors.
 * - `workflow-validation.ts` — `resolveTriggerConfig` is the per-type config
 *   gate at `POST /validate` time.
 *
 * Invariants:
 * - Config validation goes through the SHARED Zod schemas in
 *   `@janusly/shared/src/trigger-types` so the API, engine, and web agree.
 * - The executor NEVER reaches out to SMTP / the bucket / the MCP server —
 *   it is a pure passthrough. The ingestion seam owns all I/O.
 */

import {
  WebhookReceivedConfigSchema,
  EmailReceivedConfigSchema,
  FileDroppedConfigSchema,
  McpServerEventConfigSchema,
  isTriggerNodeType,
  type EmailReceivedConfig,
  type FileDroppedConfig,
  type McpServerEventConfig,
  type TriggerNodeType,
  type WebhookReceivedConfig,
} from "@janusly/shared/src/trigger-types";
import type { NodeExecutor } from "./node-registry";

/**
 * Resolve + validate a trigger node's config against its shared schema.
 * Throws a `ZodError` on a malformed config; callers in the engine catch
 * it via the standard executor envelope (run lands `failed` with the
 * offending path) and the validator surfaces it as an issue.
 */
export function resolveTriggerConfig(type: TriggerNodeType, config: unknown):
  | WebhookReceivedConfig
  | EmailReceivedConfig
  | FileDroppedConfig
  | McpServerEventConfig {
  switch (type) {
    case "webhook_received":
      return WebhookReceivedConfigSchema.parse(config);
    case "email_received":
      return EmailReceivedConfigSchema.parse(config);
    case "file_dropped":
      return FileDroppedConfigSchema.parse(config);
    case "mcp_server_event":
      return McpServerEventConfigSchema.parse(config);
  }
}

/**
 * Read the normalized inbound event the ingestion seam stuffed into the
 * run input. `startRun` persists `input` under `runs.inputJson.input`, and
 * `executeNode` merges it onto every node's context as `ctx.context.input`
 * (the same path `{{context.input.*}}` templates resolve; see
 * `getRunMetadata` + the merge in `execute-node.ts`). A manual
 * `POST /start` has no such block — the executor falls back to an empty
 * object.
 */
function readTriggerEvent(ctx: { context: Record<string, unknown> }): Record<string, unknown> {
  const input = ctx.context.input;
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const maybeEvent = (input as Record<string, unknown>).event;
    if (maybeEvent && typeof maybeEvent === "object" && !Array.isArray(maybeEvent)) {
      return maybeEvent as Record<string, unknown>;
    }
  }
  return {};
}

/** Build a passthrough executor for a given trigger node type. */
function makeTriggerExecutor(type: TriggerNodeType): NodeExecutor {
  return async (ctx) => {
    // Validate the operator's authored config as a last line of defense —
    // a malformed config that slipped past `POST /validate` (e.g. an
    // operator hand-editing the advanced JSON) fails the node rather than
    // silently succeeding with a half-formed trigger.
    resolveTriggerConfig(type, ctx.config);
    const triggeredAt = new Date().toISOString();
    return {
      status: "completed",
      output: {
        triggeredBy: type,
        triggeredAt,
        event: readTriggerEvent(ctx),
      },
    };
  };
}

/** `email_received` trigger executor — passthrough; ingestion owns the SMTP relay. */
export const emailReceivedExecutor: NodeExecutor = makeTriggerExecutor("email_received");
/** Generic JSON webhook trigger executor; ingestion owns auth and dedupe. */
export const webhookReceivedExecutor: NodeExecutor = makeTriggerExecutor("webhook_received");
/** `file_dropped` trigger executor — passthrough; ingestion owns the bucket-event listener. */
export const fileDroppedExecutor: NodeExecutor = makeTriggerExecutor("file_dropped");
/** `mcp_server_event` trigger executor — passthrough; ingestion owns the MCP subscription. */
export const mcpServerEventExecutor: NodeExecutor = makeTriggerExecutor("mcp_server_event");

/** True when the node type is one of the event-driven trigger types. */
export { isTriggerNodeType };
