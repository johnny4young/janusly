/**
 * Tenant-level configuration catalog and persistence helpers.
 *
 * The process-level `.env` still owns infrastructure and secrets
 * (`DATABASE_URL`, `REDIS_URL`, provider API keys). This table is for
 * org-scoped runtime choices that can safely vary by tenant: LLM defaults,
 * AI limits, outbound HTTP bounds, email delivery posture, and workflow
 * execution policies.
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
  };
  mcp: {
    writeConsent: boolean;
    clientWriteConsent: boolean;
    clientRateLimitPerMin: number;
    clientCommandAllowlist: string;
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
};

const ALLOWED_CATEGORIES = ["ai", "http", "email", "runs", "mcp", "integrations", "objectstore", "auth"] as const;
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
    return normalized;
  }

  if (typeof value !== "string") throw new Error(`${definition.key} must be a string`);
  const normalized = value.trim();
  if (!normalized) {
    // List-shaped keys (e.g. allowed-domain lists) opt-in to empty via
    // `allowEmpty: true` — empty means "no restriction" for those keys.
    // Existing string keys still reject empty inputs.
    if (definition.allowEmpty) return "";
    throw new Error(`${definition.key} must be a non-empty string`);
  }
  if (FORBIDDEN_CONFIG_VALUE_PATTERN.test(normalized)) {
    throw new Error(`${definition.key} must not contain secret-like values`);
  }
  if (definition.allowedValues && !definition.allowedValues.includes(normalized)) {
    throw new Error(`${definition.key} must be one of: ${definition.allowedValues.join(", ")}`);
  }
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
    },
    mcp: {
      writeConsent: readBoolean(values, "mcp.writeConsent"),
      clientWriteConsent: readBoolean(values, "mcp.clientWriteConsent"),
      clientRateLimitPerMin: readNumber(values, "mcp.clientRateLimitPerMin"),
      clientCommandAllowlist: readString(values, "mcp.clientCommandAllowlist"),
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
  };
}

/**
 * Per-org authentication policy snapshot consumed by the auth resolver +
 * SSO callback. Narrow read by design — the membership resolver runs on
 * every authenticated request, so fetching the full 22-key snapshot
 * there would double the per-request query budget.
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
    // `mcp.writeConsent` + `mcp.clientWriteConsent` have no env overlay by design — see the catalog definition.
    JANUSLY_MCP_CLIENT_RATE_LIMIT_PER_MIN: String(config.mcp.clientRateLimitPerMin),
    JANUSLY_MCP_ALLOWED_COMMANDS: config.mcp.clientCommandAllowlist,
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
