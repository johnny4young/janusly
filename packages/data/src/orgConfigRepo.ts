/**
 * Tenant-level configuration catalog and persistence helpers.
 *
 * The process-level `.env` still owns infrastructure and secrets
 * (`DATABASE_URL`, `REDIS_URL`, provider API keys). This table is for
 * org-scoped runtime choices that can safely vary by tenant: LLM defaults,
 * AI limits, outbound HTTP bounds, email delivery posture, workflow execution
 * policies, and tenant opt-in flags for guarded features.
 *
 * Used by:
 * - `apps/api/src/index.ts` — `GET /org/config` and `POST /org/config`.
 *
 * Invariants:
 * - Every DB query filters by `orgId`.
 * - Values are validated against this closed catalog before insert/update.
 * - Secret material is not stored here; use `credentials.secret_ref` and env
 *   or a vault for actual provider keys and workflow secrets.
 */

import { db, orgConfigs } from "@janusly/db";
import { and, eq, inArray } from "drizzle-orm";

export type OrgConfigValueType = "string" | "number" | "boolean";
export type OrgConfigSource = "default" | "env" | "tenant";

export type OrgConfigDefinition = {
  key: string;
  category: string;
  description: string;
  valueType: OrgConfigValueType;
  defaultValue: string | number | boolean;
  envKeys?: readonly string[];
  allowedValues?: readonly string[];
  min?: number;
  max?: number;
  /** When `true`, the normalizer keeps the fractional part on `number`
   *  values (USD budgets need cents). Defaults to floor-to-integer so
   *  pre-existing integer keys (rate limits, byte caps, etc.) keep their
   *  existing behaviour. */
  fractional?: boolean;
  /** When `true`, the string normalizer accepts `""` (typically used by
   *  list-shaped keys where empty means "no restriction"). Defaults
   *  false so existing string keys still reject empty inputs. */
  allowEmpty?: boolean;
  /** Optional post-normalization validator. Runs after the standard
   *  pipeline (type check, trim, FORBIDDEN_CONFIG_VALUE_PATTERN,
   *  allowedValues, min/max bounds, allowEmpty short-circuit). Throw
   *  with a human-readable message to reject a value. Opt-in per
   *  definition — existing keys without `validate:` keep their
   *  behaviour byte-for-byte. */
  validate?: (value: string | number | boolean) => void;
};

export type OrgConfigEntry = OrgConfigDefinition & {
  orgId: string;
  value: string | number | boolean;
  source: OrgConfigSource;
  updatedAt: Date | null;
};

export type OrgConfigSnapshot = {
  ai: {
    provider: string;
    openaiModel: string;
    anthropicModel: string;
    timeoutMs: number;
    maxRetries: number;
    promptMaxChars: number;
    rateLimitPerMin: number;
    confidenceCalibrationEnabled: boolean;
  };
  http: {
    timeoutMs: number;
    maxResponseBytes: number;
    maxRedirects: number;
    streamPreviewBytes: number;
  };
  email: {
    provider: string;
    from: string;
    rateLimitPerMin: number;
  };
  runs: {
    requireSavedWorkflow: boolean;
    subworkflowMaxDepth: number;
    streamMaxSubscriptions: number;
  };
  mcp: {
    writeConsent: boolean;
    clientWriteConsent: boolean;
    clientRateLimitPerMin: number;
    clientCommandAllowlist: string;
    stdioMaxLifetimeMs: number;
    stdioMaxStderrBytes: number;
    stdioMaxVmKb: number;
  };
  integrations: {
    slack: {
      rateLimitPerMin: number;
    };
    github: {
      rateLimitPerMin: number;
    };
    webhook: {
      rateLimitPerMin: number;
    };
    pdf: {
      rateLimitPerMin: number;
    };
  };
  objectstore: {
    provider: string;
  };
  memory: {
    enabled: boolean;
  };
  autoHealing: {
    enabled: boolean;
    autoApply: boolean;
    maxAttemptsPerSignature: number;
    loopWindowDays: number;
  };
  recovery: {
    autoCreateItems: boolean;
    debounceWindowSeconds: number;
  };
  value: {
    hourlyCost: number;
    minutesSavedPerRecovery: number;
    baselineMttrSeconds: number;
  };
  onboarding: {
    enabled: boolean;
  };
};

const ALLOWED_CATEGORIES = [
  "ai",
  "http",
  "email",
  "runs",
  "mcp",
  "integrations",
  "objectstore",
  "auth",
  "memory",
  "auto-healing",
  "recovery",
  "value",
  "retention",
  "onboarding",
] as const;

/** Closed enum of memory kinds eligible for persistence. Mirrors the memory
 *  policy's eligibility and retention tables. Used by `memory.allowedKinds`
 *  (CSV) and `memory.retentionDaysByKind` (JSON keys). */
const MEMORY_KINDS = [
  "recovery_rationale",
  "run_summary",
  "runbook_fragment",
  "patch_rationale",
] as const;

/** Per-kind maximum retention in days from the memory policy. */
const MEMORY_RETENTION_MAX_DAYS: Record<(typeof MEMORY_KINDS)[number], number> = {
  recovery_rationale: 730,
  run_summary: 365,
  // Admin-configurable runbook fragments still need a finite, auditable cap.
  runbook_fragment: 36_500,
  patch_rationale: 730,
};

function isMemoryKind(value: string): value is (typeof MEMORY_KINDS)[number] {
  return (MEMORY_KINDS as readonly string[]).includes(value);
}

function validateMemoryAllowedKinds(value: string | number | boolean): void {
  if (typeof value !== "string") throw new Error("memory.allowedKinds must be a string");
  if (value === "") return;
  const parts = value.split(",").map((part) => part.trim()).filter((part) => part.length > 0);
  for (const part of parts) {
    if (!isMemoryKind(part)) {
      throw new Error(
        `memory.allowedKinds entry "${part}" is not one of: ${MEMORY_KINDS.join(", ")}`,
      );
    }
  }
}

function validateMemoryRetentionDaysByKind(value: string | number | boolean): void {
  if (typeof value !== "string") throw new Error("memory.retentionDaysByKind must be a string");
  if (value === "") return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("memory.retentionDaysByKind must be valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("memory.retentionDaysByKind must be a JSON object");
  }
  for (const [key, days] of Object.entries(parsed as Record<string, unknown>)) {
    if (!isMemoryKind(key)) {
      throw new Error(
        `memory.retentionDaysByKind key "${key}" is not one of: ${MEMORY_KINDS.join(", ")}`,
      );
    }
    if (typeof days !== "number" || !Number.isInteger(days) || days <= 0) {
      throw new Error(`memory.retentionDaysByKind["${key}"] must be a positive integer`);
    }
    const max = MEMORY_RETENTION_MAX_DAYS[key];
    if (days > max) {
      throw new Error(`memory.retentionDaysByKind["${key}"] must be <= ${max}`);
    }
  }
}
const FORBIDDEN_CONFIG_NAME_PATTERN =
  /(secret|token|password|api[_-]?key|authorization|cookie|private[_-]?key|database[_-]?url|redis[_-]?url|supabase|service[_-]?role|service[_-]?token)/i;
const FORBIDDEN_CONFIG_VALUE_PATTERN =
  /^(sk-|sk-ant-|xox[baprs]-|ghp_|github_pat_|ya29\.|AKIA|Bearer\s+)|^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.|-----BEGIN [A-Z ]+PRIVATE KEY-----|postgres(?:ql)?:\/\/|redis:\/\//i;

export const ORG_CONFIG_DEFINITIONS = [
  {
    key: "ai.provider",
    category: "ai",
    description: "Default LLM provider for this tenant. Provider API keys still come from env or secret management.",
    valueType: "string",
    defaultValue: "openai",
    envKeys: ["JANUSLY_LLM_PROVIDER"],
    allowedValues: ["openai", "anthropic"],
  },
  {
    key: "ai.openai.model",
    category: "ai",
    description: "Default OpenAI model for this tenant.",
    valueType: "string",
    defaultValue: "gpt-4o-mini",
    envKeys: ["OPENAI_MODEL"],
  },
  {
    key: "ai.anthropic.model",
    category: "ai",
    description: "Default Anthropic model for this tenant.",
    valueType: "string",
    defaultValue: "claude-haiku-4-5-20251001",
    envKeys: ["ANTHROPIC_MODEL"],
  },
  {
    key: "ai.timeoutMs",
    category: "ai",
    description: "LLM request timeout in milliseconds.",
    valueType: "number",
    defaultValue: 30_000,
    envKeys: ["OPENAI_TIMEOUT_MS"],
    min: 1,
  },
  {
    key: "ai.maxRetries",
    category: "ai",
    description: "AI SDK retry count for LLM calls.",
    valueType: "number",
    defaultValue: 2,
    envKeys: ["OPENAI_MAX_RETRIES"],
    min: 0,
  },
  {
    key: "ai.promptMaxChars",
    category: "ai",
    description: "Maximum prompt length accepted by AI endpoints.",
    valueType: "number",
    defaultValue: 4_000,
    envKeys: ["AI_PROMPT_MAX_CHARS"],
    min: 1,
  },
  {
    key: "ai.rateLimitPerMin",
    category: "ai",
    description: "Per-org AI request limit per minute.",
    valueType: "number",
    defaultValue: 30,
    envKeys: ["AI_RATE_LIMIT_PER_MIN"],
    min: 1,
  },
  {
    key: "ai.budgetMonthlyUsd",
    category: "ai",
    description: "Monthly USD ceiling for org-wide AI spend. 0 disables the gate (no budget).",
    valueType: "number",
    defaultValue: 0,
    envKeys: ["JANUSLY_AI_BUDGET_MONTHLY_USD"],
    min: 0,
    fractional: true,
  },
  {
    key: "ai.budgetWarnPercent",
    category: "ai",
    description: "Percent of the monthly budget at which the operator gets a billing.budget.warned audit row + Recovery Center banner.",
    valueType: "number",
    defaultValue: 80,
    envKeys: ["JANUSLY_AI_BUDGET_WARN_PERCENT"],
    min: 0,
    max: 100,
  },
  {
    key: "ai.budgetExceededPolicy",
    category: "ai",
    description: "What happens when the monthly budget is exceeded. 'warn' proceeds + audits + toasts; 'block' returns HTTP 402 / mode=fallback.",
    valueType: "string",
    defaultValue: "warn",
    envKeys: ["JANUSLY_AI_BUDGET_EXCEEDED_POLICY"],
    allowedValues: ["warn", "block"],
  },
  {
    key: "ai.confidenceCalibrationEnabled",
    category: "ai",
    description:
      "Tenant switch for calibrating AI patch-suggestion confidence against observed accept/reject history. Defaults to true: a daily sweep fits a per-approach linear curve from recovery feedback and the recovery dialog shows the calibrated value as primary. Set false to show the model's raw self-rated confidence unchanged (no curve fit, no calibrated number).",
    valueType: "boolean",
    defaultValue: true,
  },
  {
    key: "http.timeoutMs",
    category: "http",
    description: "Default outbound HTTP timeout budget in milliseconds.",
    valueType: "number",
    defaultValue: 30_000,
    envKeys: ["JANUSLY_HTTP_TIMEOUT_MS"],
    min: 1,
  },
  {
    key: "http.maxResponseBytes",
    category: "http",
    description: "Default maximum decoded body size for HTTP nodes and http.request.",
    valueType: "number",
    defaultValue: 1_000_000,
    envKeys: ["JANUSLY_HTTP_MAX_RESPONSE_BYTES"],
    min: 1,
  },
  {
    key: "http.maxRedirects",
    category: "http",
    description: "Default maximum redirect hops for outbound HTTP.",
    valueType: "number",
    defaultValue: 5,
    envKeys: ["JANUSLY_HTTP_MAX_REDIRECTS"],
    min: 0,
  },
  {
    key: "http.streamPreviewBytes",
    category: "http",
    description: "How many bytes of a streamed HTTP response body get captured into the persisted node output for audit when `bodyMode: \"stream\"` is set on an `http` node or `http.request` tool. The full response still flows through the byte cap (`http.maxResponseBytes`); only the preview is what survives into `run_nodes.state_json`. Range 1024..1048576 (1 KB..1 MB), default 65536 (64 KB).",
    valueType: "number",
    defaultValue: 65_536,
    envKeys: ["JANUSLY_HTTP_STREAM_PREVIEW_BYTES"],
    min: 1_024,
    max: 1_048_576,
  },
  {
    key: "email.provider",
    category: "email",
    description: "Default mailer provider for this tenant. Provider API keys still come from env or secret management.",
    valueType: "string",
    defaultValue: "noop",
    envKeys: ["JANUSLY_MAILER_PROVIDER"],
    allowedValues: ["resend", "sendgrid", "noop"],
  },
  {
    key: "email.from",
    category: "email",
    description: "Default sender address for email.send when the workflow input omits from.",
    valueType: "string",
    defaultValue: "onboarding@resend.dev",
    envKeys: ["JANUSLY_MAILER_FROM"],
  },
  {
    key: "email.rateLimitPerMin",
    category: "email",
    description: "Per-org email.send limit per minute.",
    valueType: "number",
    defaultValue: 100,
    envKeys: ["JANUSLY_EMAIL_RATE_LIMIT_PER_MIN"],
    min: 1,
  },
  {
    key: "runs.requireSavedWorkflow",
    category: "runs",
    description: "Require runs to start from a saved workflow instead of an ad-hoc payload.",
    valueType: "boolean",
    defaultValue: false,
    envKeys: ["JANUSLY_REQUIRE_SAVED_WORKFLOW"],
  },
  {
    key: "subworkflow.maxDepth",
    category: "runs",
    description: "Maximum nested subworkflow depth.",
    valueType: "number",
    defaultValue: 5,
    envKeys: ["JANUSLY_MAX_SUBWORKFLOW_DEPTH"],
    min: 1,
  },
  {
    key: "runs.streamMaxSubscriptions",
    category: "runs",
    description: "Maximum concurrent live-run SSE subscriptions per organization (per API replica).",
    valueType: "number",
    defaultValue: 50,
    envKeys: ["JANUSLY_STREAM_MAX_SUBSCRIPTIONS"],
    min: 1,
    max: 1000,
  },
  {
    key: "mcp.writeConsent",
    category: "mcp",
    description: "Allow MCP write tools (workflows.save, etc.) to mutate this organization. Process-wide JANUSLY_MCP_WRITES_ENABLED must also be true. NO env fallback by design — each tenant must opt in explicitly via the admin API.",
    valueType: "boolean",
    defaultValue: false,
  },
  {
    key: "mcp.clientWriteConsent",
    category: "mcp",
    description: "Allow Janusly's `mcp_tool` workflow steps to invoke write-side tools on external MCP servers. Process-wide JANUSLY_MCP_CLIENT_WRITES_ENABLED must also be true. NO env fallback by design — each tenant must opt in explicitly via the admin API.",
    valueType: "boolean",
    defaultValue: false,
  },
  {
    key: "mcp.clientRateLimitPerMin",
    category: "mcp",
    description: "Per-org rate limit for external `mcp_tool` invocations (per minute, applied as `mcp_client.<alias>.<toolName>` bucket).",
    valueType: "number",
    defaultValue: 60,
    envKeys: ["JANUSLY_MCP_CLIENT_RATE_LIMIT_PER_MIN"],
    min: 1,
  },
  {
    key: "mcp.clientCommandAllowlist",
    category: "mcp",
    description: "Comma-separated list of executable commands that stdio MCP connections in this org may spawn (e.g. \"node,uvx,npx\"). Empty = falls back to the process-wide JANUSLY_MCP_ALLOWED_COMMANDS env. The fail-closed posture means no stdio connection can be created unless at least one allowlist (env OR tenant) is non-empty.",
    valueType: "string",
    defaultValue: "",
    envKeys: ["JANUSLY_MCP_ALLOWED_COMMANDS"],
    allowEmpty: true,
  },
  {
    key: "mcp.stdioMaxLifetimeMs",
    category: "mcp",
    description: "Max wall-clock lifetime in milliseconds for a stdio MCP child process. The sandbox layer kills the child (SIGTERM then SIGKILL after a short grace) past this. Range 60000..3600000 (1 min..1 h).",
    valueType: "number",
    defaultValue: 600_000,
    envKeys: ["JANUSLY_MCP_STDIO_MAX_LIFETIME_MS"],
    min: 60_000,
    max: 3_600_000,
  },
  {
    key: "mcp.stdioMaxStderrBytes",
    category: "mcp",
    description: "Max bytes of stderr the sandbox captures from a stdio MCP child before killing it. Captured stderr is secret-shape redacted before logging. Range 1024..1048576 (1 KiB..1 MiB).",
    valueType: "number",
    defaultValue: 65_536,
    envKeys: ["JANUSLY_MCP_STDIO_MAX_STDERR_BYTES"],
    min: 1024,
    max: 1_048_576,
  },
  {
    key: "mcp.stdioMaxVmKb",
    category: "mcp",
    description: "Max virtual-memory size (KB) enforced via Linux ulimit -v on stdio MCP children. Applied only on Linux when JANUSLY_MCP_SANDBOX_ENFORCE_LINUX is true; macOS / Windows ignore this value. Range 131072..4194304 (128 MiB..4 GiB).",
    valueType: "number",
    defaultValue: 524_288,
    envKeys: ["JANUSLY_MCP_STDIO_MAX_VM_KB"],
    min: 131_072,
    max: 4_194_304,
  },
  {
    key: "slack.rateLimitPerMin",
    category: "integrations",
    description: "Per-org slack.post tool calls per minute.",
    valueType: "number",
    defaultValue: 60,
    envKeys: ["JANUSLY_SLACK_RATE_LIMIT_PER_MIN"],
    min: 1,
  },
  {
    key: "github.rateLimitPerMin",
    category: "integrations",
    description: "Per-org github.create_issue tool calls per minute.",
    valueType: "number",
    defaultValue: 60,
    envKeys: ["JANUSLY_GITHUB_RATE_LIMIT_PER_MIN"],
    min: 1,
  },
  {
    key: "webhook.rateLimitPerMin",
    category: "integrations",
    description: "Per-org webhook.send tool calls per minute.",
    valueType: "number",
    defaultValue: 120,
    envKeys: ["JANUSLY_WEBHOOK_RATE_LIMIT_PER_MIN"],
    min: 1,
  },
  {
    key: "pdf.rateLimitPerMin",
    category: "integrations",
    description: "Per-org pdf.generate tool calls per minute.",
    valueType: "number",
    defaultValue: 30,
    envKeys: ["JANUSLY_PDF_RATE_LIMIT_PER_MIN"],
    min: 1,
  },
  {
    key: "objectstore.provider",
    category: "objectstore",
    description: "Object-store backend used by pdf.generate. Provider credentials still come from env.",
    valueType: "string",
    defaultValue: "noop",
    envKeys: ["JANUSLY_OBJECT_STORE_PROVIDER"],
    allowedValues: ["s3", "local", "noop"],
  },
  {
    key: "auth.allowedEmailDomains",
    category: "auth",
    description:
      "Comma-separated list of email domains permitted to authenticate into this org (e.g. \"acme.com,partner.com\"). Empty = no restriction. The membership resolver rejects any principal whose email domain is not in the list. Applies to both Supabase JWT logins and post-callback SSO sessions — defense in depth against an IdP that surfaces users from unintended domains.",
    valueType: "string",
    defaultValue: "",
    allowEmpty: true,
  },
  {
    key: "auth.mfaRequired",
    category: "auth",
    description:
      "Marker only — Janusly stores the requirement for policy visibility but does not block logins. Actual MFA enforcement happens at the identity provider (Okta, Azure AD, etc.). When set, the policy evaluator logs a server-side warning if the principal lacks a verifiable MFA hint.",
    valueType: "boolean",
    defaultValue: false,
  },
  {
    key: "auth.sessionTtlSeconds",
    category: "auth",
    description:
      "Per-org override for the SSO session token TTL (in seconds). Range 300..86400 (5 minutes..24 hours). Default 28800 (8 hours). The SSO callback reads this at token issuance time; runtime session-token verification uses each token's own embedded expiry, so changing this only affects newly-minted sessions.",
    valueType: "number",
    defaultValue: 28800,
    min: 300,
    max: 86400,
  },
  {
    key: "memory.enabled",
    category: "memory",
    description:
      "Tenant master switch for persistent cross-run memory. Required true (alongside JANUSLY_MEMORY_ENABLED=true at the process level) for any memory write. NO env fallback by design — each tenant must opt in explicitly via the admin API. Defaults to false (off). See docs/memory-policy.md.",
    valueType: "boolean",
    defaultValue: false,
  },
  {
    key: "memory.allowedKinds",
    category: "memory",
    description:
      "Comma-separated list of memory kinds eligible for write in this org. Closed enum: recovery_rationale, run_summary, runbook_fragment, patch_rationale. Empty = no kinds enabled (memory feature is on but no writes accepted yet). See docs/memory-policy.md.",
    valueType: "string",
    defaultValue: "",
    allowEmpty: true,
    validate: validateMemoryAllowedKinds,
  },
  {
    key: "memory.retentionDaysByKind",
    category: "memory",
    description:
      "JSON-encoded per-kind retention override (e.g. {\"recovery_rationale\":180,\"run_summary\":90}). Empty = use the per-kind defaults from docs/memory-policy.md. Each value is a positive integer day count bounded by the per-kind maximum from the policy table.",
    valueType: "string",
    defaultValue: "",
    allowEmpty: true,
    validate: validateMemoryRetentionDaysByKind,
  },
  {
    key: "memory.recallMaxEntries",
    category: "memory",
    description:
      "Hard cap on the number of memory entries returned per recall call. Range 1..32, default 8. See docs/memory-policy.md.",
    valueType: "number",
    defaultValue: 8,
    min: 1,
    max: 32,
  },
  {
    key: "memory.recallMaxBytes",
    category: "memory",
    description:
      "Hard cap on the total bytes returned per recall call. Range 1024..65536 (1 KiB..64 KiB), default 8192. See docs/memory-policy.md.",
    valueType: "number",
    defaultValue: 8_192,
    min: 1_024,
    max: 65_536,
  },
  {
    key: "memory.embeddingProvider",
    category: "memory",
    description:
      "Provider used to compute embeddings for memory entries. Closed enum: ollama (self-hosted, v1 default) / voyage / openai. Anthropic does not currently offer an embeddings endpoint; AGENTS.md's 'Anthropic-only' rule applies to LLM completions, not embeddings. Empty = use the env default (ollama). Stored on each entry for explicit re-embedding. See docs/memory-policy.md.",
    valueType: "string",
    defaultValue: "",
    allowEmpty: true,
    allowedValues: ["ollama", "voyage", "openai"],
  },
  {
    key: "memory.embeddingModel",
    category: "memory",
    description:
      "Model id used to compute embeddings for memory entries. Empty = use the env default (bge-m3 when provider is ollama). Stored on each entry for explicit re-embedding when the provider/model changes. See docs/memory-policy.md.",
    valueType: "string",
    defaultValue: "",
    allowEmpty: true,
  },
  {
    key: "memory.embeddingBaseUrl",
    category: "memory",
    description:
      "Base URL of the embedding service when the operator runs an external instance (e.g. a remote Ollama box). Empty = use the env default (OLLAMA_BASE_URL, defaulting to http://ollama:11434 inside Compose). This URL is operator-supplied infrastructure config and bypasses the SSRF guard for the embedding fetch by design — workflow-author content never influences which URL is hit.",
    valueType: "string",
    defaultValue: "",
    envKeys: ["OLLAMA_BASE_URL"],
    allowEmpty: true,
  },
  {
    key: "autoHealing.enabled",
    category: "auto-healing",
    description:
      "Tenant master switch for supervised auto-healing. Required true (alongside JANUSLY_AUTO_HEALING_ENABLED=true at the process level) for the background scanner to consider this org's DLQ rows. NO env fallback by design — each tenant must opt in explicitly via the admin API. Defaults to false (off); the scanner skips every step before reading the recent DLQ window.",
    valueType: "boolean",
    defaultValue: false,
  },
  {
    key: "autoHealing.autoApply",
    category: "auto-healing",
    description:
      "Tenant opt-in for automatic application of validated patches without operator click. Required true (alongside JANUSLY_AUTO_HEALING_AUTO_APPLY=true at the process level) for the watcher's auto-apply branch to fire. Independent of autoHealing.enabled — both apply only when the master gate is also on. Defaults to false; the watcher leaves validated rows pending operator decision.",
    valueType: "boolean",
    defaultValue: false,
  },
  {
    key: "autoHealing.maxAttemptsPerSignature",
    category: "auto-healing",
    description:
      "Loop-breaker ceiling: the same normalized failure signature can be auto-healed at most this many times inside the loop window. The count is over prior auto_healing_runs rows for (orgId, signature) and is captured at diagnose time. Range 1..10, default 3.",
    valueType: "number",
    defaultValue: 3,
    min: 1,
    max: 10,
  },
  {
    key: "autoHealing.loopWindowDays",
    category: "auto-healing",
    description:
      "Loop-breaker window in days: prior auto_healing_runs rows for (orgId, signature) older than this are not counted against the per-signature cap. Range 1..90, default 14.",
    valueType: "number",
    defaultValue: 14,
    min: 1,
    max: 90,
  },
  {
    key: "recovery.autoCreateItems",
    category: "recovery",
    description:
      "Tenant switch for automatic recovery item creation when a DLQ row is inserted. Defaults to true so the ownership workflow is on for existing tenants; operators can disable it per org through the closed org config catalog.",
    valueType: "boolean",
    defaultValue: true,
  },
  {
    key: "recovery.debounceWindowSeconds",
    category: "recovery",
    description:
      "Failure-storm debounce window. A new DLQ entry sharing (orgId, workflowId, errorSignature) with a still-open recovery item whose last occurrence is within this many seconds attaches as a child occurrence instead of spawning a new incident. Default 300; recommended operating range 30..3600; 0 disables debounce (one item per DLQ row). Non-zero values below 30 are clamped up to 30 by the engine.",
    valueType: "number",
    defaultValue: 300,
    min: 0,
    max: 3600,
  },
  {
    key: "value.hourlyCost",
    category: "value",
    description:
      "Operator-supplied 'engineer hourly cost' assumption used by the Value Dashboard's dollar-savings estimate. Pure assumption: Janusly never measures payroll. Range 0..2000, default 50 (USD-equivalent; currency formatting is locale-driven on the client). Fractional values supported so $125.75 doesn't silently truncate to $125. Every dollar surface in the UI carries an 'estimate' badge linking back to this knob.",
    valueType: "number",
    defaultValue: 50,
    min: 0,
    max: 2000,
    fractional: true,
  },
  {
    key: "value.minutesSavedPerRecovery",
    category: "value",
    description:
      "Operator-supplied 'minutes saved per resolved failure' assumption used by the Value Dashboard. Drives hours-saved + dollar-saved estimates via clustersResolved * value / 60 * hourlyCost. Range 0..480, default 30. Tune to match the operator's manual-triage baseline measured during the private-beta MTTR experiment.",
    valueType: "number",
    defaultValue: 30,
    min: 0,
    max: 480,
  },
  {
    key: "value.baselineMttrSeconds",
    category: "value",
    description:
      "Operator-supplied 'pre-Janusly MTTR' baseline (seconds) used by the Value Dashboard's before/after comparison. Default 0 is the sentinel for 'baseline not measured yet' — the dashboard renders 'Awaiting private-beta data' in the 'Before' slot until the operator sets a real value (typically after the discovery call with a design partner). Range 0..86400 (one day).",
    valueType: "number",
    defaultValue: 0,
    min: 0,
    max: 86_400,
  },
  {
    key: "retention.runEventsDays",
    category: "retention",
    description:
      "Days of run-event history (`run_events`) kept before the daily retention sweep purges them, scoped to this org. Run timelines older than this are deleted unless a per-row `holdUntil` legal hold is in force. Range 7..365, default 90.",
    valueType: "number",
    defaultValue: 90,
    envKeys: ["JANUSLY_RETENTION_RUN_EVENTS_DAYS"],
    min: 7,
    max: 365,
  },
  {
    key: "retention.auditLogsDays",
    category: "retention",
    description:
      "Days of audit-log history (`audit_logs`) kept for this org before the daily retention sweep purges them. The floor is 30 days but the default is 365 to satisfy common compliance evidence windows; a per-row `holdUntil` legal hold exempts rows referenced by an active investigation. Range 30..730, default 365.",
    valueType: "number",
    defaultValue: 365,
    envKeys: ["JANUSLY_RETENTION_AUDIT_LOGS_DAYS"],
    min: 30,
    max: 730,
  },
  {
    key: "retention.usageEventsDays",
    category: "retention",
    description:
      "Days of usage-event history (`usage_events`) kept for this org before the daily retention sweep purges them. Drives billing/value-dashboard rollups, so the floor is 30 days. A per-row `holdUntil` legal hold exempts a row. Range 30..365, default 90.",
    valueType: "number",
    defaultValue: 90,
    envKeys: ["JANUSLY_RETENTION_USAGE_EVENTS_DAYS"],
    min: 30,
    max: 365,
  },
  {
    key: "retention.recoveryFeedbackDays",
    category: "retention",
    description:
      "Days of recovery-feedback history (`recovery_feedback`) kept for this org before the daily retention sweep purges them. The labeled accept/reject signal feeds the AI patch loop, so the floor is 30 days. A per-row `holdUntil` legal hold exempts a row. Range 30..365, default 180.",
    valueType: "number",
    defaultValue: 180,
    envKeys: ["JANUSLY_RETENTION_RECOVERY_FEEDBACK_DAYS"],
    min: 30,
    max: 365,
  },
  {
    key: "retention.memoryEntriesDays",
    category: "retention",
    description:
      "Days of memory-entry history (`memory_entries`) kept for this org before the daily retention sweep purges them, by `created_at`. Gated by the memory policy (docs/memory-policy.md); independent of and an upper bound over the per-kind `retain_until` expiry, so a row is removed by whichever of the two fires first. A per-row `holdUntil` legal hold exempts a row from the org-level sweep. Range 7..730, default 90.",
    valueType: "number",
    defaultValue: 90,
    envKeys: ["JANUSLY_RETENTION_MEMORY_ENTRIES_DAYS"],
    min: 7,
    max: 730,
  },
  {
    key: "onboarding.enabled",
    category: "onboarding",
    description:
      "Tenant switch for the \"first recovered run\" onboarding checklist banner. Defaults to true so the guided flow is on; set false to hide the banner for this org (e.g. once the team is past onboarding). Disabling makes GET /onboarding skip all milestone derivation and return a hidden state — flipping it back on resumes from the org's derived progress.",
    valueType: "boolean",
    defaultValue: true,
  },
] as const satisfies readonly OrgConfigDefinition[];

export type OrgConfigKey = typeof ORG_CONFIG_DEFINITIONS[number]["key"];

function assertSafeOrgConfigDefinition(definition: OrgConfigDefinition): void {
  if (!ALLOWED_CATEGORIES.includes(definition.category as typeof ALLOWED_CATEGORIES[number])) {
    throw new Error(`Invalid org config category: ${definition.category}`);
  }
  if (FORBIDDEN_CONFIG_NAME_PATTERN.test(definition.key)) {
    throw new Error(`Forbidden org config key: ${definition.key}`);
  }
  for (const envKey of definition.envKeys ?? []) {
    if (FORBIDDEN_CONFIG_NAME_PATTERN.test(envKey)) {
      throw new Error(`Forbidden org config env fallback: ${envKey}`);
    }
  }
}

for (const definition of ORG_CONFIG_DEFINITIONS) {
  assertSafeOrgConfigDefinition(definition);
}

function findDefinition(key: string): OrgConfigDefinition | undefined {
  return ORG_CONFIG_DEFINITIONS.find((definition) => definition.key === key);
}

function parseEnvValue(definition: OrgConfigDefinition, raw: string): string | number | boolean {
  if (definition.valueType === "boolean") {
    if (raw === "true") return true;
    if (raw === "false") return false;
    throw new Error(`${definition.key} must be true or false`);
  }
  if (definition.valueType === "number") return normalizeOrgConfigValue(definition, Number(raw));
  return normalizeOrgConfigValue(definition, raw);
}

function defaultValueFor(
  definition: OrgConfigDefinition,
  env: NodeJS.ProcessEnv,
): { value: string | number | boolean; source: "default" | "env" } {
  for (const envKey of definition.envKeys ?? []) {
    const raw = env[envKey];
    if (raw === undefined || raw === "") continue;
    try {
      return { value: parseEnvValue(definition, raw), source: "env" };
    } catch {
      return { value: definition.defaultValue, source: "default" };
    }
  }
  return { value: definition.defaultValue, source: "default" };
}

function parseStoredValue(value: unknown, fallback: string | number | boolean): string | number | boolean {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  return fallback;
}

/** Validate and normalize one value before it is written to `org_configs`. */
export function normalizeOrgConfigValue(definition: OrgConfigDefinition, value: unknown): string | number | boolean {
  if (definition.valueType === "boolean") {
    if (typeof value !== "boolean") throw new Error(`${definition.key} must be a boolean`);
    if (definition.validate) definition.validate(value);
    return value;
  }

  if (definition.valueType === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${definition.key} must be a finite number`);
    // Integer-valued keys (rate limits, byte caps) floor; fractional keys
    // (USD budgets) keep the cents. Default to integer to preserve the
    // existing behaviour of every pre-budget config key.
    const normalized = definition.fractional ? value : Math.floor(value);
    if (definition.min !== undefined && normalized < definition.min) {
      throw new Error(`${definition.key} must be >= ${definition.min}`);
    }
    if (definition.max !== undefined && normalized > definition.max) {
      throw new Error(`${definition.key} must be <= ${definition.max}`);
    }
    if (definition.validate) definition.validate(normalized);
    return normalized;
  }

  if (typeof value !== "string") throw new Error(`${definition.key} must be a string`);
  const normalized = value.trim();
  if (!normalized) {
    // List-shaped keys (e.g. allowed-domain lists) opt-in to empty via
    // `allowEmpty: true` — empty means "no restriction" for those keys.
    // Existing string keys still reject empty inputs.
    if (definition.allowEmpty) {
      if (definition.validate) definition.validate("");
      return "";
    }
    throw new Error(`${definition.key} must be a non-empty string`);
  }
  if (FORBIDDEN_CONFIG_VALUE_PATTERN.test(normalized)) {
    throw new Error(`${definition.key} must not contain secret-like values`);
  }
  if (definition.allowedValues && !definition.allowedValues.includes(normalized)) {
    throw new Error(`${definition.key} must be one of: ${definition.allowedValues.join(", ")}`);
  }
  if (definition.validate) definition.validate(normalized);
  return normalized;
}

/** List tenant-visible configuration values, merging tenant rows over env defaults. */
export async function listOrgConfig(orgId: string, env: NodeJS.ProcessEnv = process.env): Promise<OrgConfigEntry[]> {
  const rows = await db.select().from(orgConfigs).where(eq(orgConfigs.orgId, orgId));
  const byKey = new Map(rows.map((row) => [row.key, row]));

  return ORG_CONFIG_DEFINITIONS.map((definition) => {
    const row = byKey.get(definition.key);
    const fallback = defaultValueFor(definition, env);
    return {
      ...definition,
      orgId,
      value: row ? parseStoredValue(row.valueJson, fallback.value) : fallback.value,
      source: row ? "tenant" : fallback.source,
      updatedAt: row?.updatedAt ?? null,
    };
  });
}

function valuesByKey(entries: OrgConfigEntry[]): Map<OrgConfigKey, string | number | boolean> {
  return new Map(entries.map((entry) => [entry.key as OrgConfigKey, entry.value]));
}

function readString(values: Map<OrgConfigKey, string | number | boolean>, key: OrgConfigKey): string {
  const value = values.get(key);
  if (typeof value !== "string") throw new Error(`${key} must resolve to a string`);
  return value;
}

function readNumber(values: Map<OrgConfigKey, string | number | boolean>, key: OrgConfigKey): number {
  const value = values.get(key);
  if (typeof value !== "number") throw new Error(`${key} must resolve to a number`);
  return value;
}

function readBoolean(values: Map<OrgConfigKey, string | number | boolean>, key: OrgConfigKey): boolean {
  const value = values.get(key);
  if (typeof value !== "boolean") throw new Error(`${key} must resolve to a boolean`);
  return value;
}

/** Return a typed config snapshot for runtime code that should honor tenant overrides. */
export async function getOrgConfigSnapshot(orgId: string, env: NodeJS.ProcessEnv = process.env): Promise<OrgConfigSnapshot> {
  const values = valuesByKey(await listOrgConfig(orgId, env));
  return {
    ai: {
      provider: readString(values, "ai.provider"),
      openaiModel: readString(values, "ai.openai.model"),
      anthropicModel: readString(values, "ai.anthropic.model"),
      timeoutMs: readNumber(values, "ai.timeoutMs"),
      maxRetries: readNumber(values, "ai.maxRetries"),
      promptMaxChars: readNumber(values, "ai.promptMaxChars"),
      rateLimitPerMin: readNumber(values, "ai.rateLimitPerMin"),
      confidenceCalibrationEnabled: readBoolean(values, "ai.confidenceCalibrationEnabled"),
    },
    http: {
      timeoutMs: readNumber(values, "http.timeoutMs"),
      maxResponseBytes: readNumber(values, "http.maxResponseBytes"),
      maxRedirects: readNumber(values, "http.maxRedirects"),
      streamPreviewBytes: readNumber(values, "http.streamPreviewBytes"),
    },
    email: {
      provider: readString(values, "email.provider"),
      from: readString(values, "email.from"),
      rateLimitPerMin: readNumber(values, "email.rateLimitPerMin"),
    },
    runs: {
      requireSavedWorkflow: readBoolean(values, "runs.requireSavedWorkflow"),
      subworkflowMaxDepth: readNumber(values, "subworkflow.maxDepth"),
      streamMaxSubscriptions: readNumber(values, "runs.streamMaxSubscriptions"),
    },
    mcp: {
      writeConsent: readBoolean(values, "mcp.writeConsent"),
      clientWriteConsent: readBoolean(values, "mcp.clientWriteConsent"),
      clientRateLimitPerMin: readNumber(values, "mcp.clientRateLimitPerMin"),
      clientCommandAllowlist: readString(values, "mcp.clientCommandAllowlist"),
      stdioMaxLifetimeMs: readNumber(values, "mcp.stdioMaxLifetimeMs"),
      stdioMaxStderrBytes: readNumber(values, "mcp.stdioMaxStderrBytes"),
      stdioMaxVmKb: readNumber(values, "mcp.stdioMaxVmKb"),
    },
    integrations: {
      slack: {
        rateLimitPerMin: readNumber(values, "slack.rateLimitPerMin"),
      },
      github: {
        rateLimitPerMin: readNumber(values, "github.rateLimitPerMin"),
      },
      webhook: {
        rateLimitPerMin: readNumber(values, "webhook.rateLimitPerMin"),
      },
      pdf: {
        rateLimitPerMin: readNumber(values, "pdf.rateLimitPerMin"),
      },
    },
    objectstore: {
      provider: readString(values, "objectstore.provider"),
    },
    memory: {
      enabled: readBoolean(values, "memory.enabled"),
    },
    autoHealing: {
      enabled: readBoolean(values, "autoHealing.enabled"),
      autoApply: readBoolean(values, "autoHealing.autoApply"),
      maxAttemptsPerSignature: readNumber(values, "autoHealing.maxAttemptsPerSignature"),
      loopWindowDays: readNumber(values, "autoHealing.loopWindowDays"),
    },
    recovery: {
      autoCreateItems: readBoolean(values, "recovery.autoCreateItems"),
      debounceWindowSeconds: readNumber(values, "recovery.debounceWindowSeconds"),
    },
    value: {
      hourlyCost: readNumber(values, "value.hourlyCost"),
      minutesSavedPerRecovery: readNumber(values, "value.minutesSavedPerRecovery"),
      baselineMttrSeconds: readNumber(values, "value.baselineMttrSeconds"),
    },
    onboarding: {
      enabled: readBoolean(values, "onboarding.enabled"),
    },
  };
}

/**
 * Read just the `onboarding.enabled` tenant toggle. Narrow read — the
 * onboarding route only needs this one boolean, so it reads a single scoped
 * row instead of materializing the full `OrgConfigSnapshot`. Returns the
 * catalog default (`true`) when the org has no row OR on a read error
 * (fail-open: a config-store blip must not silently hide onboarding).
 * Multi-tenant scope: the read carries `eq(orgConfigs.orgId, orgId)`.
 */
export async function isOnboardingEnabled(orgId: string): Promise<boolean> {
  const fallback = ORG_CONFIG_DEFINITIONS.find((d) => d.key === "onboarding.enabled")!
    .defaultValue as boolean;
  try {
    const rows = await db
      .select()
      .from(orgConfigs)
      .where(and(eq(orgConfigs.orgId, orgId), eq(orgConfigs.key, "onboarding.enabled")));
    const stored = rows[0]?.valueJson;
    return typeof stored === "boolean" ? stored : fallback;
  } catch (err) {
    console.warn(`[onboarding] failed to read org_configs for ${orgId}; defaulting enabled`, err);
    return fallback;
  }
}

/**
 * Per-org authentication policy snapshot consumed by the auth resolver +
 * SSO callback. Narrow read by design — the membership resolver runs on
 * every authenticated request, so fetching the full typed snapshot there would
 * double the per-request query budget.
 *
 * `allowedEmailDomains` is parsed from the comma-separated string
 * (lowercased, trimmed, empty entries dropped). Empty list = no
 * restriction.
 */
export type AuthPolicyConfig = {
  allowedEmailDomains: string[];
  mfaRequired: boolean;
  sessionTtlSeconds: number;
};

const AUTH_POLICY_KEYS = [
  "auth.allowedEmailDomains",
  "auth.mfaRequired",
  "auth.sessionTtlSeconds",
] as const satisfies readonly OrgConfigKey[];

function authPolicyDefault(): AuthPolicyConfig {
  return {
    allowedEmailDomains: [],
    mfaRequired: ORG_CONFIG_DEFINITIONS.find((d) => d.key === "auth.mfaRequired")!
      .defaultValue as boolean,
    sessionTtlSeconds: ORG_CONFIG_DEFINITIONS.find(
      (d) => d.key === "auth.sessionTtlSeconds",
    )!.defaultValue as number,
  };
}

function parseAllowedDomains(raw: string): string[] {
  return raw
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0);
}

/**
 * Read just the `auth.*` policy keys for an org. Used by
 * `apps/api/src/auth-policy.ts` on the hot path; do not extend this to
 * read non-auth keys — keep the query scoped to ≤3 rows.
 *
 * Returns catalog defaults when the org has no row for a given key.
 * Multi-tenant scope: every read carries `eq(orgConfigs.orgId, orgId)`.
 */
export async function getAuthPolicyConfig(orgId: string): Promise<AuthPolicyConfig> {
  const policy = authPolicyDefault();
  let rows: Array<typeof orgConfigs.$inferSelect> = [];
  try {
    rows = await db
      .select()
      .from(orgConfigs)
      .where(and(eq(orgConfigs.orgId, orgId), inArray(orgConfigs.key, [...AUTH_POLICY_KEYS])));
  } catch (err) {
    console.warn(`[auth-policy] failed to read org_configs for ${orgId}; using defaults`, err);
    return policy;
  }
  const byKey = new Map(rows.map((row) => [row.key, row.valueJson]));
  for (const key of AUTH_POLICY_KEYS) {
    const stored = byKey.get(key);
    if (stored === undefined) continue;
    if (key === "auth.allowedEmailDomains") {
      if (typeof stored === "string") policy.allowedEmailDomains = parseAllowedDomains(stored);
      continue;
    }
    if (key === "auth.mfaRequired") {
      if (typeof stored === "boolean") policy.mfaRequired = stored;
      continue;
    }
    if (key === "auth.sessionTtlSeconds") {
      if (typeof stored === "number" && Number.isFinite(stored)) {
        policy.sessionTtlSeconds = stored;
      }
      continue;
    }
  }
  return policy;
}

/**
 * Per-org retention policy snapshot consumed by the daily retention
 * sweep. Narrow read by design — the sweep iterates every org and only
 * needs these 5 day-count knobs, so it reads just the `retention.*` keys
 * (mirrors `getAuthPolicyConfig`'s scoped read) instead of materializing
 * the full typed `OrgConfigSnapshot` per org.
 *
 * Each value is already clamped to its catalog `[min, max]` range at
 * write time; this reader re-applies the catalog default when the org
 * has no row OR when a stored value somehow falls outside range, so the
 * sweep never deletes against a nonsense window.
 */
export type RetentionPolicyConfig = {
  runEventsDays: number;
  auditLogsDays: number;
  usageEventsDays: number;
  recoveryFeedbackDays: number;
  memoryEntriesDays: number;
};

const RETENTION_POLICY_KEYS = [
  "retention.runEventsDays",
  "retention.auditLogsDays",
  "retention.usageEventsDays",
  "retention.recoveryFeedbackDays",
  "retention.memoryEntriesDays",
] as const satisfies readonly OrgConfigKey[];

function retentionDefaultFor(key: OrgConfigKey): number {
  return ORG_CONFIG_DEFINITIONS.find((d) => d.key === key)!.defaultValue as number;
}

function retentionPolicyDefault(): RetentionPolicyConfig {
  return {
    runEventsDays: retentionDefaultFor("retention.runEventsDays"),
    auditLogsDays: retentionDefaultFor("retention.auditLogsDays"),
    usageEventsDays: retentionDefaultFor("retention.usageEventsDays"),
    recoveryFeedbackDays: retentionDefaultFor("retention.recoveryFeedbackDays"),
    memoryEntriesDays: retentionDefaultFor("retention.memoryEntriesDays"),
  };
}

/** Clamp a stored retention value into its catalog range, falling back
 *  to the catalog default if it is non-numeric or out of bounds. */
function clampRetention(key: OrgConfigKey, stored: unknown): number {
  // `findDefinition` returns the loose `OrgConfigDefinition` (with `min?`
  // / `max?`); reaching into `ORG_CONFIG_DEFINITIONS` directly would keep
  // the narrow literal union where some members lack those fields.
  const def = findDefinition(key)!;
  const fallback = def.defaultValue as number;
  if (typeof stored !== "number" || !Number.isFinite(stored)) return fallback;
  if (def.min !== undefined && stored < def.min) return fallback;
  if (def.max !== undefined && stored > def.max) return fallback;
  return stored;
}

/**
 * Read just the `retention.*` policy keys for an org. Used by the daily
 * retention sweep scheduler; keep the query scoped to ≤5 rows. Returns
 * catalog defaults when the org has no row for a given key.
 *
 * Multi-tenant scope: every read carries `eq(orgConfigs.orgId, orgId)`.
 */
export async function getRetentionPolicyConfig(orgId: string): Promise<RetentionPolicyConfig> {
  const policy = retentionPolicyDefault();
  let rows: Array<typeof orgConfigs.$inferSelect> = [];
  try {
    rows = await db
      .select()
      .from(orgConfigs)
      .where(and(eq(orgConfigs.orgId, orgId), inArray(orgConfigs.key, [...RETENTION_POLICY_KEYS])));
  } catch (err) {
    console.warn(`[retention] failed to read org_configs for ${orgId}; using defaults`, err);
    return policy;
  }
  const byKey = new Map(rows.map((row) => [row.key, row.valueJson]));
  policy.runEventsDays = clampRetention("retention.runEventsDays", byKey.get("retention.runEventsDays") ?? policy.runEventsDays);
  policy.auditLogsDays = clampRetention("retention.auditLogsDays", byKey.get("retention.auditLogsDays") ?? policy.auditLogsDays);
  policy.usageEventsDays = clampRetention("retention.usageEventsDays", byKey.get("retention.usageEventsDays") ?? policy.usageEventsDays);
  policy.recoveryFeedbackDays = clampRetention("retention.recoveryFeedbackDays", byKey.get("retention.recoveryFeedbackDays") ?? policy.recoveryFeedbackDays);
  policy.memoryEntriesDays = clampRetention("retention.memoryEntriesDays", byKey.get("retention.memoryEntriesDays") ?? policy.memoryEntriesDays);
  return policy;
}

/** Overlay tenant config onto process env names consumed by provider/runtime helpers. */
export function applyOrgConfigToEnv(
  config: OrgConfigSnapshot,
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...env,
    JANUSLY_LLM_PROVIDER: config.ai.provider,
    OPENAI_MODEL: config.ai.openaiModel,
    ANTHROPIC_MODEL: config.ai.anthropicModel,
    OPENAI_TIMEOUT_MS: String(config.ai.timeoutMs),
    OPENAI_MAX_RETRIES: String(config.ai.maxRetries),
    AI_PROMPT_MAX_CHARS: String(config.ai.promptMaxChars),
    AI_RATE_LIMIT_PER_MIN: String(config.ai.rateLimitPerMin),
    JANUSLY_HTTP_TIMEOUT_MS: String(config.http.timeoutMs),
    JANUSLY_HTTP_MAX_RESPONSE_BYTES: String(config.http.maxResponseBytes),
    JANUSLY_HTTP_MAX_REDIRECTS: String(config.http.maxRedirects),
    JANUSLY_HTTP_STREAM_PREVIEW_BYTES: String(config.http.streamPreviewBytes),
    JANUSLY_MAILER_PROVIDER: config.email.provider,
    JANUSLY_MAILER_FROM: config.email.from,
    JANUSLY_EMAIL_RATE_LIMIT_PER_MIN: String(config.email.rateLimitPerMin),
    JANUSLY_REQUIRE_SAVED_WORKFLOW: String(config.runs.requireSavedWorkflow),
    JANUSLY_MAX_SUBWORKFLOW_DEPTH: String(config.runs.subworkflowMaxDepth),
    JANUSLY_STREAM_MAX_SUBSCRIPTIONS: String(config.runs.streamMaxSubscriptions),
    // `mcp.writeConsent` + `mcp.clientWriteConsent` have no env overlay by design — see the catalog definition.
    JANUSLY_MCP_CLIENT_RATE_LIMIT_PER_MIN: String(config.mcp.clientRateLimitPerMin),
    JANUSLY_MCP_ALLOWED_COMMANDS: config.mcp.clientCommandAllowlist,
    JANUSLY_MCP_STDIO_MAX_LIFETIME_MS: String(config.mcp.stdioMaxLifetimeMs),
    JANUSLY_MCP_STDIO_MAX_STDERR_BYTES: String(config.mcp.stdioMaxStderrBytes),
    JANUSLY_MCP_STDIO_MAX_VM_KB: String(config.mcp.stdioMaxVmKb),
    JANUSLY_SLACK_RATE_LIMIT_PER_MIN: String(config.integrations.slack.rateLimitPerMin),
    JANUSLY_GITHUB_RATE_LIMIT_PER_MIN: String(config.integrations.github.rateLimitPerMin),
    JANUSLY_WEBHOOK_RATE_LIMIT_PER_MIN: String(config.integrations.webhook.rateLimitPerMin),
    JANUSLY_PDF_RATE_LIMIT_PER_MIN: String(config.integrations.pdf.rateLimitPerMin),
    JANUSLY_OBJECT_STORE_PROVIDER: config.objectstore.provider,
  };
}

/** Insert or update one tenant config override after catalog validation. */
export async function upsertOrgConfig(input: {
  orgId: string;
  key: string;
  value: unknown;
  userId?: string;
}): Promise<OrgConfigEntry> {
  const definition = findDefinition(input.key);
  if (!definition) throw new Error(`Unknown org config key: ${input.key}`);

  const value = normalizeOrgConfigValue(definition, input.value);
  const existing = await db
    .select()
    .from(orgConfigs)
    .where(and(eq(orgConfigs.orgId, input.orgId), eq(orgConfigs.key, input.key)));

  if (existing[0]) {
    await db
      .update(orgConfigs)
      .set({
        valueJson: value,
        category: definition.category,
        description: definition.description,
        valueType: definition.valueType,
        source: "tenant",
        updatedBy: input.userId,
        updatedAt: new Date(),
      })
      .where(eq(orgConfigs.id, existing[0].id));
  } else {
    await db.insert(orgConfigs).values({
      id: crypto.randomUUID(),
      orgId: input.orgId,
      key: input.key,
      valueJson: value,
      category: definition.category,
      description: definition.description,
      valueType: definition.valueType,
      source: "tenant",
      createdBy: input.userId,
      updatedBy: input.userId,
    });
  }

  return {
    ...definition,
    orgId: input.orgId,
    value,
    source: "tenant",
    updatedAt: new Date(),
  };
}

// Multi-tenant invariant: tenant-scoped reads and writes keep orgId in the predicate; document system/global exceptions - see AGENTS.md "Decision engine / RL".
