/**
 * Inbound trigger surface — the closed enum of event-driven trigger node
 * types plus their Zod 4 config schemas and the normalized inbound-payload
 * schemas the ingestion seam validates before spawning a run.
 *
 * Three trigger node types extend the runtime's existing trigger surface
 * (`webhook` / `schedule` / `approval`) with event-driven starts:
 *   - `email_received` — a per-org alias receives mail; the relay POSTs a
 *     normalized payload to the ingestion seam.
 *   - `file_dropped` — an object-store bucket-event notification (or polling
 *     fallback) reports a new object under a watched prefix.
 *   - `mcp_server_event` — an external MCP server's resource-changed
 *     notification (MCP 2025-06-18 subscription primitive).
 *
 * The grammar cap on AI generation stays at 11 branches — these three types
 * are NOT emitted by `/ai/generate-workflow`. The LLM emits a `noop`
 * placeholder named after the requested trigger and the operator promotes it
 * in the Inspector (mirror of the `wait_*` / `schedule_*` convention).
 *
 * This module lives in `@janusly/shared` (zero runtime deps beyond Zod) so
 * the engine (config validation + run spawn), the API (ingestion route +
 * repo), and the web bundle (Inspector promotion + summaries) all import the
 * SAME contract. Adding a new trigger type means: a new entry in
 * `triggerNodeTypeValues`, a new config schema + inbound-payload schema here,
 * a branch in the engine's `resolveTriggerConfig`, a branch in the API
 * ingestion dispatcher, and the EN/ES Inspector copy.
 *
 * Used by:
 * - `packages/engine/src/triggers.ts` — config resolution + executor.
 * - `packages/engine/src/workflow-validation.ts` — per-type config rule.
 * - `apps/api/src/routes/trigger-ingest-routes.ts` — ingestion seam.
 * - `packages/data/src/triggerEventsRepo.ts` — structured-event persistence.
 * - `apps/web/src/constants.ts` — Inspector labels + config summaries.
 *
 * Invariants:
 * - Records use Zod 4's two-arg `z.record(z.string(), z.unknown())` form.
 * - Size caps are byte-length caps enforced at ingestion AND mirrored on the
 *   schema (`emailBodyMaxBytes`, `attachmentMaxBytes`) so a payload that
 *   exceeds the cap is rejected with a stable code before it ever reaches a
 *   run.
 */

import { z } from "zod";

export { utf8ByteLength } from "./utf8";

/**
 * Closed set of event-driven trigger node-type discriminators. A strict
 * subset of `nodeTypeValues` — every entry here must ALSO appear in
 * `@janusly/shared/src/workflow:nodeTypeValues`.
 */
export const triggerNodeTypeValues = [
  "email_received",
  "file_dropped",
  "mcp_server_event",
] as const;

/** Zod enum derived from `triggerNodeTypeValues`. */
export const TriggerNodeTypeSchema = z.enum(triggerNodeTypeValues);

/** One of the three event-driven trigger node types. */
export type TriggerNodeType = (typeof triggerNodeTypeValues)[number];

/** Type guard — narrows an arbitrary string to a known trigger node type. */
export function isTriggerNodeType(value: unknown): value is TriggerNodeType {
  return typeof value === "string" && (triggerNodeTypeValues as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Size caps (byte lengths). Enforced at the ingestion seam; mirrored on the
// inbound-payload schemas so callers see the same limit at parse time.
// ---------------------------------------------------------------------------

/** Email body cap (1 MiB per the AC). Bodies above this are rejected. */
export const EMAIL_BODY_MAX_BYTES = 1_048_576;
/** Per-attachment cap before object-store upload (also 1 MiB). */
export const ATTACHMENT_MAX_BYTES = 1_048_576;
/** Max attachments accepted on a single inbound email. */
export const MAX_ATTACHMENTS = 20;
/** Max bytes for a file-dropped object's reported metadata blob. */
export const FILE_METADATA_MAX_BYTES = 65_536;
/** Max bytes for an MCP server-event resource payload. */
export const MCP_EVENT_PAYLOAD_MAX_BYTES = 65_536;

/**
 * Default per-trigger storm guard: max ingestion fires per minute per
 * `(orgId, workflowVersionId, nodeId)`. The operator can lower it via the
 * node config; the engine clamps to `[1, TRIGGER_RATE_LIMIT_MAX_PER_MIN]`.
 */
export const TRIGGER_DEFAULT_RATE_LIMIT_PER_MIN = 60;
/** Hard ceiling on the per-trigger rate limit (defense against a typo'd huge value). */
export const TRIGGER_RATE_LIMIT_MAX_PER_MIN = 10_000;

// ---------------------------------------------------------------------------
// Per-trigger NODE config schemas — what the operator authors on the node.
// Loose-but-typed: validate the fields the executor / ingestion relies on,
// leave the rest passthrough (mirrors `node-configs.ts` posture).
// ---------------------------------------------------------------------------

/**
 * `email_received` node config. `aliasKey` is the local-part of the per-org
 * inbound address `<aliasKey>@<inbound-domain>`; the relay resolves it to the
 * org + workflow version. `dkimRequired` defaults to `true` — an unverified
 * sender is rejected at the seam unless the operator explicitly opts out.
 */
export const EmailReceivedConfigSchema = z
  .object({
    aliasKey: z
      .string()
      .trim()
      .min(1, "email_received.aliasKey is required")
      .max(128)
      // Local-part safe charset — alnum, dot, dash, underscore, plus. No `@`.
      .regex(/^[a-zA-Z0-9._+-]+$/, "email_received.aliasKey must be a valid email local-part"),
    dkimRequired: z.boolean().optional(),
    /** Optional allow-list of sender domains; empty/absent = accept any DKIM-passing sender. */
    fromDomains: z.array(z.string().trim().min(1)).max(50).optional(),
    rateLimitPerMin: z
      .number()
      .int()
      .min(1)
      .max(TRIGGER_RATE_LIMIT_MAX_PER_MIN)
      .optional(),
  })
  .passthrough();

/**
 * `file_dropped` node config. `bucket` + `prefix` scope which object-store
 * notifications fire the trigger. `prefix` is matched against the object key
 * (the org-prefix is enforced separately at the seam so a tenant can't watch
 * another tenant's keys).
 */
export const FileDroppedConfigSchema = z
  .object({
    bucket: z.string().trim().min(1, "file_dropped.bucket is required").max(256),
    prefix: z.string().trim().max(1024).optional(),
    /** Optional closed list of file extensions (no dot) to filter on. */
    extensions: z.array(z.string().trim().min(1).max(32)).max(50).optional(),
    rateLimitPerMin: z
      .number()
      .int()
      .min(1)
      .max(TRIGGER_RATE_LIMIT_MAX_PER_MIN)
      .optional(),
  })
  .passthrough();

/**
 * `mcp_server_event` node config. `connectionAlias` references a registered
 * `mcp_connections` row; `resourceUri` is the MCP resource the workflow
 * subscribes to. `eventTypes` optionally filters the notification method
 * names (e.g. `notifications/resources/updated`).
 */
export const McpServerEventConfigSchema = z
  .object({
    connectionAlias: z
      .string()
      .trim()
      .min(1, "mcp_server_event.connectionAlias is required")
      .max(128),
    resourceUri: z.string().trim().min(1, "mcp_server_event.resourceUri is required").max(2048),
    eventTypes: z.array(z.string().trim().min(1).max(128)).max(20).optional(),
    rateLimitPerMin: z
      .number()
      .int()
      .min(1)
      .max(TRIGGER_RATE_LIMIT_MAX_PER_MIN)
      .optional(),
  })
  .passthrough();

/** Per-trigger-type config schema registry (declared `satisfies` for inference). */
export const TRIGGER_CONFIG_SCHEMAS = {
  email_received: EmailReceivedConfigSchema,
  file_dropped: FileDroppedConfigSchema,
  mcp_server_event: McpServerEventConfigSchema,
} satisfies Record<TriggerNodeType, z.ZodTypeAny>;

/** Mapped type — `TriggerConfigByType["email_received"]` is the inferred config shape. */
export type TriggerConfigByType = {
  [K in TriggerNodeType]: z.infer<(typeof TRIGGER_CONFIG_SCHEMAS)[K]>;
};

export type EmailReceivedConfig = z.infer<typeof EmailReceivedConfigSchema>;
export type FileDroppedConfig = z.infer<typeof FileDroppedConfigSchema>;
export type McpServerEventConfig = z.infer<typeof McpServerEventConfigSchema>;

// ---------------------------------------------------------------------------
// Normalized inbound-payload schemas — what the ingestion seam accepts after
// the relay / bucket-notification listener / MCP subscriber has normalized
// the upstream event. These are deliberately transport-agnostic: a real SMTP
// relay, an SES forwarder, a manual test POST, or a replay all produce the
// SAME shape. Attachment BODIES are NOT carried here (they're uploaded to the
// object store by the seam); the schema carries only attachment metadata.
// ---------------------------------------------------------------------------

/** One inbound email attachment's metadata (the body is uploaded separately). */
export const EmailAttachmentMetaSchema = z.object({
  filename: z.string().trim().min(1).max(512),
  contentType: z.string().trim().min(1).max(256).optional(),
  /** Reported byte size; the seam re-checks the actual uploaded body length. */
  sizeBytes: z.number().int().nonnegative().max(ATTACHMENT_MAX_BYTES).optional(),
});

/** Normalized inbound email payload accepted by `POST /triggers/email/ingest`. */
export const EmailReceivedPayloadSchema = z.object({
  /** The per-org alias local-part the message was sent to. */
  aliasKey: z.string().trim().min(1).max(128),
  from: z.string().trim().min(1).max(512),
  to: z.string().trim().min(1).max(512).optional(),
  subject: z.string().trim().max(2048).optional().default(""),
  /** Plain-text or HTML body. Byte-capped at ingestion to `EMAIL_BODY_MAX_BYTES`. */
  body: z.string().max(EMAIL_BODY_MAX_BYTES * 2).optional().default(""),
  /** Whether the relay reports a passing DKIM signature for this message. */
  dkimPass: z.boolean().optional().default(false),
  messageId: z.string().trim().max(998).optional(),
  attachments: z.array(EmailAttachmentMetaSchema).max(MAX_ATTACHMENTS).optional().default([]),
  receivedAt: z.string().trim().max(64).optional(),
});

/** Normalized inbound file-dropped payload accepted by `POST /triggers/file/ingest`. */
export const FileDroppedPayloadSchema = z.object({
  bucket: z.string().trim().min(1).max(256),
  /** Object key relative to the bucket (the seam re-checks the org prefix). */
  key: z.string().trim().min(1).max(2048),
  sizeBytes: z.number().int().nonnegative().optional(),
  contentType: z.string().trim().min(1).max(256).optional(),
  etag: z.string().trim().max(256).optional(),
  eventName: z.string().trim().max(256).optional(),
  receivedAt: z.string().trim().max(64).optional(),
});

/** Normalized inbound MCP server-event payload accepted by `POST /triggers/mcp/ingest`. */
export const McpServerEventPayloadSchema = z.object({
  connectionAlias: z.string().trim().min(1).max(128),
  resourceUri: z.string().trim().min(1).max(2048),
  /** The MCP notification method name (e.g. `notifications/resources/updated`). */
  eventType: z.string().trim().min(1).max(128),
  /** Arbitrary resource payload; byte-capped at ingestion. */
  payload: z.record(z.string(), z.unknown()).optional(),
  receivedAt: z.string().trim().max(64).optional(),
});

export type EmailReceivedPayload = z.infer<typeof EmailReceivedPayloadSchema>;
export type FileDroppedPayload = z.infer<typeof FileDroppedPayloadSchema>;
export type McpServerEventPayload = z.infer<typeof McpServerEventPayloadSchema>;

/** Closed enum of structured trigger-event lifecycle statuses persisted in `trigger_events`. */
export const triggerEventStatusValues = ["received", "started", "skipped", "failed"] as const;
/** Zod enum derived from `triggerEventStatusValues`. */
export const TriggerEventStatusSchema = z.enum(triggerEventStatusValues);
/** One structured trigger-event status. */
export type TriggerEventStatus = (typeof triggerEventStatusValues)[number];

/**
 * Resolve the effective per-trigger rate limit from a node config's optional
 * `rateLimitPerMin`, clamping to the documented `[1, MAX]` range and falling
 * back to the default when unset or invalid.
 */
export function resolveTriggerRateLimitPerMin(rateLimitPerMin: unknown): number {
  if (typeof rateLimitPerMin !== "number" || !Number.isFinite(rateLimitPerMin)) {
    return TRIGGER_DEFAULT_RATE_LIMIT_PER_MIN;
  }
  const floored = Math.floor(rateLimitPerMin);
  if (floored < 1) return 1;
  if (floored > TRIGGER_RATE_LIMIT_MAX_PER_MIN) return TRIGGER_RATE_LIMIT_MAX_PER_MIN;
  return floored;
}
