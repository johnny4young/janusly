/**
 * Credential, connector, external-runtime, plugin, and MCP tables.
 *
 * Re-exported through `../schema.ts`; consumers should use `@janusly/db`.
 */

import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const credentials = pgTable(
  "credentials",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    name: text("name").notNull(),
    kind: text("kind").notNull(),
    secretRef: text("secret_ref").notNull(),
    metadata: jsonb("metadata"),
    // Optional operator-declared expiry for the underlying secret (token /
    // webhook / DSN). Null = no expiry tracked. Only metadata — the secret
    // value resolves through the managed/legacy provider behind `secret_ref`.
    // Powers the credential-expiry warning scan + the panel's expiry badge.
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    // Optimistic-concurrency token for secret-ref rotation. Millisecond
    // precision (timestamptz(3)) on purpose: the rotation route compares it
    // as an If-Match against the JS Date it round-trips through ISO, and full
    // microsecond precision would never equal a re-serialized ms-precision
    // value — so a first rotation would always look like a conflict.
    updatedAt: timestamp("updated_at", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("credentials_org_name_idx").on(table.orgId, table.name),
    index("credentials_org_idx").on(table.orgId),
  ],
);

/**
 * Versioned encrypted values for credentials managed by Janusly.
 *
 * `credentials.secret_ref` points at one row using the opaque
 * `janusly-secret://<id>` scheme. Each plaintext is encrypted with a random
 * data-encryption key; that key is wrapped by the process root key. The root
 * key never enters PostgreSQL. Legacy environment-variable references remain
 * valid for credentials created before this table existed.
 *
 * No foreign key is intentional: revoked versions remain inspectable as
 * metadata after a credential is deleted, but a revoked row can never resolve.
 */
export const credentialSecretVersions = pgTable(
  "credential_secret_versions",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    credentialId: text("credential_id").notNull(),
    version: integer("version").notNull(),
    ciphertext: text("ciphertext").notNull(),
    dataNonce: text("data_nonce").notNull(),
    dataTag: text("data_tag").notNull(),
    wrappedKey: text("wrapped_key").notNull(),
    wrapNonce: text("wrap_nonce").notNull(),
    wrapTag: text("wrap_tag").notNull(),
    keyVersion: integer("key_version").notNull().default(1),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("credential_secret_versions_credential_version_idx")
      .on(table.credentialId, table.version),
    index("credential_secret_versions_org_credential_idx")
      .on(table.orgId, table.credentialId, table.createdAt.desc()),
  ],
);

/**
 * One Slack app/team binding for signed recovery-item interactions.
 *
 * The signing secret remains in the managed/legacy credential substrate; this
 * row stores only the credential name plus a bounded Slack-user → Janusly-user mapping.
 * Callback lookup by opaque connection id is the deliberate cross-tenant
 * system exception, but the signed team id must still match before any mapped
 * identity is authorized. No foreign keys keep the integration orphan-tolerant
 * when a credential or member is rotated/deleted.
 */
export const slackInteractionConnections = pgTable(
  "slack_interaction_connections",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    name: text("name").notNull(),
    teamId: text("team_id").notNull(),
    signingCredentialName: text("signing_credential_name").notNull(),
    userMappings: jsonb("user_mappings")
      .$type<Array<{ slackUserId: string; userId: string }>>()
      .notNull()
      .default([]),
    enabled: boolean("enabled").notNull().default(true),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("slack_interaction_connections_org_name_idx").on(table.orgId, table.name),
    uniqueIndex("slack_interaction_connections_org_team_idx").on(table.orgId, table.teamId),
    index("slack_interaction_connections_org_enabled_idx").on(table.orgId, table.enabled),
  ],
);

/**
 * Durable replay claims for signed Slack callbacks.
 *
 * The id is a SHA-256 digest of connection id + signed timestamp + exact raw
 * body. Claim insertion and opportunistic expiry cleanup share a transaction,
 * so retries across API replicas cannot repeat a recovery mutation and storage
 * remains bounded to the recent verification window for active connections.
 */
export const slackInteractionReceipts = pgTable(
  "slack_interaction_receipts",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    connectionId: text("connection_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("slack_interaction_receipts_connection_created_idx")
      .on(table.connectionId, table.createdAt),
  ],
);

/**
 * One signed, observation-only connection to an external workflow runtime.
 *
 * The HMAC secret remains behind the credential store. The opaque connection
 * id is the only cross-tenant callback lookup and grants no control authority.
 * No foreign keys keep historical observations inspectable after a credential
 * rotation or connection removal.
 */
export const externalRuntimeConnections = pgTable(
  "external_runtime_connections",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    name: text("name").notNull(),
    runtimeKey: text("runtime_key").notNull(),
    signingCredentialName: text("signing_credential_name").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("external_runtime_connections_org_name_idx").on(table.orgId, table.name),
    uniqueIndex("external_runtime_connections_org_runtime_idx").on(table.orgId, table.runtimeKey),
    index("external_runtime_connections_org_enabled_idx").on(table.orgId, table.enabled),
  ],
);

/**
 * Immutable signed event receipts. The composite identity provides replay
 * protection across API replicas while retaining stale events as forensic
 * evidence. `payload_json` is scrubbed and size-bounded before insertion.
 */
export const externalRuntimeEvents = pgTable(
  "external_runtime_events",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    connectionId: text("connection_id").notNull(),
    eventId: text("event_id").notNull(),
    source: text("source").notNull(),
    eventType: text("event_type").notNull(),
    subject: text("subject"),
    eventTime: timestamp("event_time", { withTimezone: true }).notNull(),
    sequence: bigint("sequence", { mode: "number" }).notNull(),
    payloadJson: jsonb("payload_json").notNull(),
    projectionState: text("projection_state").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("external_runtime_events_connection_source_event_idx")
      .on(table.connectionId, table.source, table.eventId),
    index("external_runtime_events_org_received_idx")
      .on(table.orgId, table.receivedAt.desc()),
  ],
);

/** Latest monotonic projection of an externally owned workflow. */
export const externalWorkflows = pgTable(
  "external_workflows",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    connectionId: text("connection_id").notNull(),
    externalWorkflowId: text("external_workflow_id").notNull(),
    name: text("name").notNull(),
    version: text("version"),
    snapshotJson: jsonb("snapshot_json"),
    evidenceJson: jsonb("evidence_json").notNull().default([]),
    lastSequence: bigint("last_sequence", { mode: "number" }).notNull().default(-1),
    lastEventId: text("last_event_id"),
    lastObservedAt: timestamp("last_observed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("external_workflows_connection_external_idx")
      .on(table.connectionId, table.externalWorkflowId),
    // Mirrors `listExternalWorkflows`' full ORDER BY (`lastObservedAt DESC,
    // externalWorkflowId ASC`); NULLS FIRST because `lastObservedAt` is
    // nullable and a plain `ORDER BY ... DESC` means NULLS FIRST — drizzle's
    // default DESC NULLS LAST index cannot satisfy the sort.
    index("external_workflows_org_observed_workflow_idx")
      .on(table.orgId, table.lastObservedAt.desc().nullsFirst(), table.externalWorkflowId.asc()),
  ],
);

/** Latest monotonic projection of an externally owned workflow run. */
export const externalRuns = pgTable(
  "external_runs",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    connectionId: text("connection_id").notNull(),
    externalWorkflowId: text("external_workflow_id").notNull(),
    externalRunId: text("external_run_id").notNull(),
    status: text("status").notNull().default("unknown"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    snapshotJson: jsonb("snapshot_json"),
    evidenceJson: jsonb("evidence_json").notNull().default([]),
    lastSequence: bigint("last_sequence", { mode: "number" }).notNull().default(-1),
    lastEventId: text("last_event_id"),
    lastObservedAt: timestamp("last_observed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("external_runs_connection_external_idx")
      .on(table.connectionId, table.externalRunId),
    // Mirrors `listExternalRuns`' full ORDER BY; NULLS FIRST on the nullable
    // `lastObservedAt` so the index can serve the sort (see external_workflows).
    index("external_runs_org_observed_created_idx")
      .on(table.orgId, table.lastObservedAt.desc().nullsFirst(), table.createdAt.desc().nullsFirst()),
    index("external_runs_connection_workflow_idx")
      .on(table.connectionId, table.externalWorkflowId, table.lastObservedAt.desc()),
  ],
);

/** Latest monotonic projection of one externally owned run step. */
export const externalRunSteps = pgTable(
  "external_run_steps",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    connectionId: text("connection_id").notNull(),
    externalWorkflowId: text("external_workflow_id").notNull(),
    externalRunId: text("external_run_id").notNull(),
    externalStepId: text("external_step_id").notNull(),
    name: text("name").notNull(),
    status: text("status").notNull().default("unknown"),
    attempt: integer("attempt").notNull().default(1),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    snapshotJson: jsonb("snapshot_json"),
    evidenceJson: jsonb("evidence_json").notNull().default([]),
    lastSequence: bigint("last_sequence", { mode: "number" }).notNull().default(-1),
    lastEventId: text("last_event_id"),
    lastObservedAt: timestamp("last_observed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("external_run_steps_connection_run_step_idx")
      .on(table.connectionId, table.externalRunId, table.externalStepId),
    // Mirrors `listExternalRunSteps`' full ORDER BY; NULLS FIRST on the
    // nullable `lastObservedAt` (see external_workflows).
    index("external_run_steps_org_observed_created_idx")
      .on(table.orgId, table.lastObservedAt.desc().nullsFirst(), table.createdAt.desc().nullsFirst()),
  ],
);

/**
 * Read-only failure projection derived from signed external run/step events.
 *
 * A later success may mark the same subject as observed recovered, but this
 * table never grants Janusly verified-recovery credit because Janusly did not
 * control the source runtime's effect.
 */
export const externalRecoveryCases = pgTable(
  "external_recovery_cases",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    connectionId: text("connection_id").notNull(),
    subjectKey: text("subject_key").notNull(),
    subjectKind: text("subject_kind").notNull(),
    externalWorkflowId: text("external_workflow_id").notNull(),
    externalRunId: text("external_run_id").notNull(),
    externalStepId: text("external_step_id"),
    state: text("state").notNull(),
    failureSnapshotJson: jsonb("failure_snapshot_json"),
    evidenceJson: jsonb("evidence_json").notNull().default([]),
    firstDetectedAt: timestamp("first_detected_at", { withTimezone: true }).notNull(),
    lastObservedAt: timestamp("last_observed_at", { withTimezone: true }).notNull(),
    observedRecoveredAt: timestamp("observed_recovered_at", { withTimezone: true }),
    lastSequence: bigint("last_sequence", { mode: "number" }).notNull(),
    lastEventId: text("last_event_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("external_recovery_cases_connection_subject_idx")
      .on(table.connectionId, table.subjectKey),
    index("external_recovery_cases_org_state_observed_idx")
      .on(table.orgId, table.state, table.lastObservedAt.desc()),
  ],
);

export const installedPlugins = pgTable(
  "installed_plugins",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    pluginId: text("plugin_id").notNull(),
    configJson: jsonb("config_json"),
    installedBy: text("installed_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [uniqueIndex("installed_plugins_org_plugin_idx").on(table.orgId, table.pluginId)],
);

/**
 * External MCP servers an admin has registered for an org. Each row is
 * one alias-addressable connection that workflow steps of type
 * `mcp_tool` resolve against. Two transports are supported:
 *
 *  - `stdio`: spawn a local child process via `command` + `args` and
 *    speak JSON-RPC over stdin/stdout. `command` MUST appear in
 *    `JANUSLY_MCP_ALLOWED_COMMANDS` (or the per-org override) — admins
 *    explicitly opt in to executables, not to arbitrary binaries.
 *  - `sse`: open a remote SSE connection to `url`. The URL is checked
 *    through the outbound target-policy validator before the SDK
 *    transport opens. Empty env-vars at connect time fail closed.
 *
 * `envRefs` is a closed-shape JSONB: `Record<string, { kind: "env",
 * name: string }>`. The child process / outbound HTTP receives
 * `process.env[ref.name]` resolved server-side; the connection row
 * never carries actual secret values. For stdio transport the spawn
 * env is a strict whitelist of `{ PATH, ...resolvedEnvRefs }` only —
 * no `process.env` leak so a misconfigured MCP server can't read
 * `DATABASE_URL` / `JANUSLY_RESUME_TOKEN_SECRET`.
 *
 * `status` is the discovery / health state: `pending` (just created,
 * not discovered), `active` (discovered + tools cached), `failed`
 * (discovery threw), `disabled` (admin paused).
 *
 * Multi-tenant scope: every read carries `eq(mcpConnections.orgId, orgId)`.
 * Unique on `(orgId, alias)`. Transport-shape consistency (stdio rows
 * require `command`, sse rows require `url`) is enforced in the repo's
 * `createConnection` / `updateConnection` helpers rather than via a DB
 * CHECK — matching the codebase convention of application-layer
 * validation over DB constraints.
 */
export const mcpConnections = pgTable(
  "mcp_connections",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    alias: text("alias").notNull(),
    transport: text("transport").notNull(),
    command: text("command"),
    args: jsonb("args"),
    url: text("url"),
    envRefs: jsonb("env_refs"),
    enabled: boolean("enabled").notNull().default(true),
    status: text("status").notNull().default("pending"),
    statusReason: text("status_reason"),
    // Admin opt-in: when true, the connection's enabled tool descriptors
    // (with their sanitised descriptions) get appended to the AI Studio's
    // system prompt at generation time so the LLM can reference them in
    // `noop` placeholders the operator promotes in the Inspector. Default
    // `false` — descriptions come from third-party MCP servers and are
    // a potential prompt-injection vector; admin must explicitly opt in.
    exposeToAi: boolean("expose_to_ai").notNull().default(false),
    lastDiscoveryAt: timestamp("last_discovery_at", { withTimezone: true }),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    uniqueIndex("mcp_connections_org_alias_idx").on(table.orgId, table.alias),
  ],
);

/**
 * Per-tool descriptor cached from the MCP server at discovery time.
 * One row per `(connectionId, name)`. `enabled: false` on creation —
 * the admin opts in per-tool so a 200-tool server doesn't drown the
 * UI and so prompt-injection material from third-party descriptions
 * can't reach the LLM without explicit consent.
 *
 * `inputSchema` is the JSON Schema object the MCP protocol returns;
 * the executor validates input against this before invoking. Failures
 * to discover surface as zero rows for the connection (executor
 * refuses to call without a descriptor).
 *
 * `writeSide` defaults to `true` (fail-safe). Admin marks read-side
 * tools explicitly. The runtime dry-run gate skips write-side MCP
 * tools the same way it skips write-side integration tools.
 *
 * The delete-connection route removes descriptors before deleting the
 * parent connection.
 */
export const mcpToolDescriptors = pgTable(
  "mcp_tool_descriptors",
  {
    id: text("id").primaryKey(),
    connectionId: text("connection_id").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    inputSchema: jsonb("input_schema"),
    writeSide: boolean("write_side").notNull().default(true),
    enabled: boolean("enabled").notNull().default(false),
    // Per-tool rate-limit override. NULL = use the org default
    // (`org_configs.mcp.clientRateLimitPerMin`, default 60/min). A
    // positive integer overrides the org default for this descriptor
    // only — the `mcp_client.<alias>.<toolname>` bucket inherits the
    // value at execute time. Set / cleared by admins via the existing
    // tool-flags PATCH route; audited as `mcp.tool.rate_limit_set`.
    rateLimitPerMin: integer("rate_limit_per_min"),
    // Per-tool admin opt-in flag for LLM exposure. Default `false`
    // — even when the parent connection has `expose_to_ai: true`, a
    // descriptor only surfaces in `/ai/generate-workflow`'s system
    // prompt when BOTH the connection AND the descriptor flag are
    // `true`. The fail-safe default forces the operator to review
    // each tool individually before its description (operator-
    // supplied data from a third-party MCP server) reaches the LLM.
    // Audited as `mcp.tool.expose_to_ai_set` with before/after on
    // each toggle.
    exposeToAi: boolean("expose_to_ai").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    uniqueIndex("mcp_tool_descriptors_connection_name_idx").on(table.connectionId, table.name),
  ],
);
