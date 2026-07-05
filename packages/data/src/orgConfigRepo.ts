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
 * - `apps/api/src/routes/org-routes.ts` — `GET /org/config` and
 *   `POST /org/config`.
 *
 * Invariants:
 * - Every DB query filters by `orgId`.
 * - Values are validated against this closed catalog before insert/update.
 * - Secret material is not stored here; use `credentials.secret_ref` and env
 *   or a vault for actual provider keys and workflow secrets.
 */

import { db, orgConfigs } from "@janusly/db";
import { and, eq, inArray } from "drizzle-orm";
import {
  RECOVERY_ITEM_SEVERITIES,
  SLA_SECONDS_BY_SEVERITY,
  type RecoveryItemSeverity,
} from "@janusly/shared";

import {
  ORG_CONFIG_DEFINITIONS,
  RECOVERY_SLA_MAX_MINUTES,
  RECOVERY_SLA_MIN_MINUTES,
  defaultValueFor,
  findDefinition,
  isAiSurface,
  normalizeOrgConfigValue,
  parseStoredValue,
} from "./orgConfigCatalog";
import type {
  OrgConfigDefinition,
  OrgConfigKey,
  OrgConfigSource,
} from "./orgConfigCatalog";

// Re-export the catalog surface so every existing consumer of
// `./orgConfigRepo` (and the `@janusly/data` barrel) keeps importing the same
// names after the catalog was split out into `./orgConfigCatalog`.
export {
  AI_SURFACES,
  ORG_CONFIG_DEFINITIONS,
  isAiSurface,
  normalizeOrgConfigValue,
} from "./orgConfigCatalog";
export type {
  AiSurface,
  OrgConfigDefinition,
  OrgConfigKey,
  OrgConfigSource,
  OrgConfigValueType,
} from "./orgConfigCatalog";

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
    generationMode: string;
    /** Best-of-N candidate count for free_json generation (1 = single-shot). */
    generationCandidates: number;
    /**
     * Per-surface model override map (surface slug → model id). Empty when no
     * override is set, in which case every surface uses the global default.
     * Keys are validated against the closed `AI_SURFACES` enum at write time.
     */
    surfaceModels: Record<string, string>;
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
    db: {
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

/**
 * Parse the JSON-encoded `ai.surfaceModels` config value into a typed map.
 * The catalog validator already rejected malformed JSON at write time, so this
 * read-side parse is defensive (a hand-edited row, a future schema drift): it
 * degrades to an empty map ("no per-surface override") rather than throwing in
 * the hot snapshot path, and drops any unknown key or non-string value.
 */
function parseSurfaceModels(raw: string): Record<string, string> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out: Record<string, string> = {};
  for (const [key, model] of Object.entries(parsed as Record<string, unknown>)) {
    const normalizedModel = typeof model === "string" ? model.trim() : "";
    if (isAiSurface(key) && normalizedModel) {
      out[key] = normalizedModel;
    }
  }
  return out;
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
      generationMode: readString(values, "ai.generationMode"),
      generationCandidates: readNumber(values, "ai.generationCandidates"),
      surfaceModels: parseSurfaceModels(readString(values, "ai.surfaceModels")),
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
      db: {
        rateLimitPerMin: readNumber(values, "db.rateLimitPerMin"),
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
 * Resolve the org's per-severity recovery SLA targets, in SECONDS, merged over
 * the built-in `SLA_SECONDS_BY_SEVERITY` defaults. Narrow read — the recovery
 * item repo calls this once per incident creation / severity change, so it
 * reads the single `recovery.slaPolicies` row rather than materializing the
 * full snapshot. The stored value is a JSON object of MINUTES keyed by
 * severity (validated at write time); this read-side parse is defensive and
 * fail-open — a hand-edited row, a parse error, or a store blip degrades to
 * the full default map rather than throwing on the failure path that creates
 * recovery items. Multi-tenant scope: the read carries `eq(orgConfigs.orgId, orgId)`.
 */
export async function getRecoverySlaSeconds(
  orgId: string,
): Promise<Record<RecoveryItemSeverity, number>> {
  const resolved: Record<RecoveryItemSeverity, number> = { ...SLA_SECONDS_BY_SEVERITY };
  try {
    const rows = await db
      .select()
      .from(orgConfigs)
      .where(and(eq(orgConfigs.orgId, orgId), eq(orgConfigs.key, "recovery.slaPolicies")));
    const stored = rows[0]?.valueJson;
    if (typeof stored !== "string" || stored === "") return resolved;
    const parsed: unknown = JSON.parse(stored);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return resolved;
    const overrides: Partial<Record<RecoveryItemSeverity, number>> = {};
    for (const [key, minutes] of Object.entries(parsed as Record<string, unknown>)) {
      if (!(RECOVERY_ITEM_SEVERITIES as readonly string[]).includes(key)) return resolved;
      if (
        typeof minutes !== "number" ||
        !Number.isInteger(minutes) ||
        minutes < RECOVERY_SLA_MIN_MINUTES ||
        minutes > RECOVERY_SLA_MAX_MINUTES
      ) {
        return resolved;
      }
      overrides[key as RecoveryItemSeverity] = minutes * 60;
    }
    for (const severity of RECOVERY_ITEM_SEVERITIES) {
      resolved[severity] = overrides[severity] ?? resolved[severity];
    }
  } catch (err) {
    console.warn(`[recovery] failed to read recovery.slaPolicies for ${orgId}; using SLA defaults`, err);
  }
  return resolved;
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
  deletedWorkflowsDays: number;
};

const RETENTION_POLICY_KEYS = [
  "retention.runEventsDays",
  "retention.auditLogsDays",
  "retention.usageEventsDays",
  "retention.recoveryFeedbackDays",
  "retention.memoryEntriesDays",
  "retention.deletedWorkflowsDays",
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
    deletedWorkflowsDays: retentionDefaultFor("retention.deletedWorkflowsDays"),
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
  policy.deletedWorkflowsDays = clampRetention("retention.deletedWorkflowsDays", byKey.get("retention.deletedWorkflowsDays") ?? policy.deletedWorkflowsDays);
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
    JANUSLY_DB_TOOL_RATE_LIMIT_PER_MIN: String(config.integrations.db.rateLimitPerMin),
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

// Multi-tenant invariant: tenant-scoped reads and writes keep orgId in the predicate; document system/global exceptions - see AGENTS.md "AuthContext is Janusly-resolved".
