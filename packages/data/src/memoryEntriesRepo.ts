/**
 * Tenant-scoped vector memory store helpers.
 *
 * Persists episodic / semantic / procedural memory entries the
 * downstream consumers (memory-assisted recovery suggestions, agent
 * recall, etc.) accumulate and read back. Both write and read paths
 * pass through the two-flag consent gate (`isMemoryAllowed`) before
 * any DB work, and the content field is scrubbed via
 * `scrubSecretShapes` at write time AND re-scrubbed at read time —
 * the defense-in-depth posture the canonical memory policy demands.
 *
 * Used by:
 * - Future routes (`apps/api/src/routes/memory-routes.ts` — not in this
 *   ticket) for direct admin export / delete operations.
 * - Future engine consumers (`packages/engine/src/memory-recall.ts` —
 *   not in this ticket) for recovery-suggestion enrichment.
 *
 * Invariants:
 * - Multi-tenant scope: every query carries
 *   `eq(memoryEntries.orgId, orgId)`. The pgvector cosine ranking
 *   runs AFTER the orgId WHERE clause, never across tenants.
 * - Embedding failures NEVER persist a row — a memory entry without
 *   a usable embedding can't be recalled by similarity, so we treat
 *   "no embedding" as commit failure with a warn audit instead of
 *   storing an orphan.
 * - The recall path NEVER throws. Disabled-org, embedding-fault,
 *   secret-leak (defense-in-depth) all degrade to an empty
 *   `{ entries: [] }`.
 * - `scrubSecretShapes` runs at write time AND read time. If a new
 *   secret pattern lands in the closed regex after a row was written,
 *   recall still emits the scrubbed form.
 * - `commitMemory` / `recallMemory` fire the memory-usage recorder
 *   on success AND failure for cost / observability dashboards.
 * - Audit rows (`memory.entry.created` / `memory.entry.failed` /
 *   `memory.recall.failed`) are written inside the repo so non-route
 *   consumers (engine recall, retention job) don't have to remember to
 *   wire audit themselves.
 */

import { and, eq, gte, lte, sql, type SQL } from "drizzle-orm";
import { db, memoryEntries, auditLogs } from "@janusly/db";
import { generateEmbedding } from "@janusly/ai";
import type { EmbeddingResult } from "@janusly/ai";
import { scrubSecretShapes } from "@janusly/shared/src/error-signature";
import { SENSITIVE_KEY_PATTERN } from "@janusly/shared/src/sensitive-keys";

import { isMemoryAllowed } from "./memoryConsent";
import { getMemoryUsageRecorder, type MemoryUsageMetric } from "./memoryUsage";
import { listOrgConfig, type OrgConfigEntry } from "./orgConfigRepo";

// ─── Closed sets shared with the policy + catalog ───────────────────────────

/** Memory kind closed enum from the canonical memory policy. */
export const MEMORY_KINDS = [
  "recovery_rationale",
  "run_summary",
  "runbook_fragment",
  "patch_rationale",
] as const;

export type MemoryKind = (typeof MEMORY_KINDS)[number];

/** Per-kind default retention in days (from the canonical memory policy). */
const DEFAULT_RETENTION_DAYS: Record<MemoryKind, number> = {
  recovery_rationale: 180,
  run_summary: 90,
  runbook_fragment: 365,
  patch_rationale: 365,
};

function isMemoryKind(value: string): value is MemoryKind {
  return (MEMORY_KINDS as readonly string[]).includes(value);
}

// ─── Memory config narrow reader ────────────────────────────────────────────

export type MemoryConfig = {
  enabled: boolean;
  allowedKinds: ReadonlySet<MemoryKind>;
  retentionDaysByKind: Record<MemoryKind, number>;
  recallMaxEntries: number;
  recallMaxBytes: number;
  embeddingProvider: string;
  embeddingModel: string;
  embeddingBaseUrl: string;
};

/**
 * Narrow reader for the 7 memory.* catalog keys + the one extension
 * key. Sibling of `getAuthPolicyConfig` — keeps the hot path scoped
 * to just the rows it needs rather than reading the full snapshot.
 */
export async function getMemoryConfig(orgId: string): Promise<MemoryConfig> {
  const entries = await listOrgConfig(orgId);
  const byKey = new Map(entries.map((entry) => [entry.key, entry]));

  const enabled = readBool(byKey, "memory.enabled", false);
  const allowedKindsRaw = readString(byKey, "memory.allowedKinds", "");
  const retentionRaw = readString(byKey, "memory.retentionDaysByKind", "");
  const recallMaxEntries = readNumber(byKey, "memory.recallMaxEntries", 8);
  const recallMaxBytes = readNumber(byKey, "memory.recallMaxBytes", 8192);
  const embeddingProvider =
    readString(byKey, "memory.embeddingProvider", "") || "ollama";
  const embeddingModel =
    readString(byKey, "memory.embeddingModel", "") || "bge-m3";
  const embeddingBaseUrl = readString(byKey, "memory.embeddingBaseUrl", "");

  return {
    enabled,
    allowedKinds: parseAllowedKinds(allowedKindsRaw),
    retentionDaysByKind: parseRetentionDays(retentionRaw),
    recallMaxEntries,
    recallMaxBytes,
    embeddingProvider,
    embeddingModel,
    embeddingBaseUrl,
  };
}

function readString(
  byKey: Map<string, OrgConfigEntry>,
  key: string,
  fallback: string,
): string {
  const entry = byKey.get(key);
  if (!entry || typeof entry.value !== "string") return fallback;
  return entry.value;
}

function readNumber(
  byKey: Map<string, OrgConfigEntry>,
  key: string,
  fallback: number,
): number {
  const entry = byKey.get(key);
  if (!entry || typeof entry.value !== "number") return fallback;
  return entry.value;
}

function readBool(
  byKey: Map<string, OrgConfigEntry>,
  key: string,
  fallback: boolean,
): boolean {
  const entry = byKey.get(key);
  if (!entry || typeof entry.value !== "boolean") return fallback;
  return entry.value;
}

function parseAllowedKinds(raw: string): ReadonlySet<MemoryKind> {
  if (!raw) return new Set();
  const kinds: MemoryKind[] = [];
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (trimmed && isMemoryKind(trimmed)) kinds.push(trimmed);
  }
  return new Set(kinds);
}

function parseRetentionDays(raw: string): Record<MemoryKind, number> {
  const out = { ...DEFAULT_RETENTION_DAYS };
  if (!raw) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return out;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return out;
  }
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (isMemoryKind(key) && typeof value === "number" && Number.isInteger(value) && value > 0) {
      out[key] = value;
    }
  }
  return out;
}

// ─── Commit path ────────────────────────────────────────────────────────────

export type CommitMemoryInput = {
  orgId: string;
  workflowId?: string;
  runId?: string;
  kind: MemoryKind;
  content: string;
  metadata?: Record<string, unknown>;
};

export type CommitMemoryResult =
  | { ok: true; entryId: string }
  | { ok: false; error: CommitMemoryError };

export type CommitMemoryError =
  | "memory_disabled"
  | "kind_disabled"
  | "config_unavailable"
  | "embedding_failed"
  | "content_empty"
  | "metadata_too_large";

const MAX_METADATA_BYTES = 8 * 1024;
const MEMORY_EMBEDDING_DIMENSION = 1024;

export async function commitMemory(input: CommitMemoryInput): Promise<CommitMemoryResult> {
  const startedAt = Date.now();
  const consent = await isMemoryAllowed(input.orgId);
  if (!consent.allowed) {
    fireUsageRecorder({
      metric: "memory.commit",
      orgId: input.orgId,
      kind: input.kind,
      embeddingProvider: "",
      embeddingModel: "",
      embeddingDimension: null,
      workflowId: input.workflowId,
      runId: input.runId,
      ok: false,
      error: "memory_disabled",
      latencyMs: Date.now() - startedAt,
    });
    return { ok: false, error: "memory_disabled" };
  }

  let config: MemoryConfig;
  try {
    config = await getMemoryConfig(input.orgId);
  } catch (error) {
    console.warn("[memory] config read failed", { orgId: input.orgId, error });
    fireUsageRecorder({
      metric: "memory.commit",
      orgId: input.orgId,
      kind: input.kind,
      embeddingProvider: "",
      embeddingModel: "",
      embeddingDimension: null,
      workflowId: input.workflowId,
      runId: input.runId,
      ok: false,
      error: "config_unavailable",
      latencyMs: Date.now() - startedAt,
    });
    return { ok: false, error: "config_unavailable" };
  }
  if (!config.allowedKinds.has(input.kind)) {
    fireUsageRecorder({
      metric: "memory.commit",
      orgId: input.orgId,
      kind: input.kind,
      embeddingProvider: "",
      embeddingModel: "",
      embeddingDimension: null,
      workflowId: input.workflowId,
      runId: input.runId,
      ok: false,
      error: "kind_disabled",
      latencyMs: Date.now() - startedAt,
    });
    return { ok: false, error: "kind_disabled" };
  }

  const scrubbedContent = scrubSecretShapes(input.content).trim();
  if (!scrubbedContent) {
    fireUsageRecorder({
      metric: "memory.commit",
      orgId: input.orgId,
      kind: input.kind,
      embeddingProvider: "",
      embeddingModel: "",
      embeddingDimension: null,
      workflowId: input.workflowId,
      runId: input.runId,
      ok: false,
      error: "content_empty",
      latencyMs: Date.now() - startedAt,
    });
    return { ok: false, error: "content_empty" };
  }

  let metadataValue: Record<string, unknown> | null = null;
  if (input.metadata) {
    metadataValue = sanitizeMemoryMetadata(input.metadata);
    const serialized = JSON.stringify(metadataValue);
    if (Buffer.byteLength(serialized, "utf8") > MAX_METADATA_BYTES) {
      fireUsageRecorder({
        metric: "memory.commit",
        orgId: input.orgId,
        kind: input.kind,
        embeddingProvider: "",
        embeddingModel: "",
        embeddingDimension: null,
        workflowId: input.workflowId,
        runId: input.runId,
        ok: false,
        error: "metadata_too_large",
        latencyMs: Date.now() - startedAt,
      });
      return { ok: false, error: "metadata_too_large" };
    }
  }

  const embedding = await generateEmbedding(scrubbedContent, {
    provider: config.embeddingProvider,
    model: config.embeddingModel,
    baseUrl: config.embeddingBaseUrl || undefined,
  });

  if (!embedding.ok) {
    await writeCommitFailedAudit(input.orgId, "embedding_failed", {
      kind: input.kind,
      embeddingProvider: config.embeddingProvider,
      embeddingModel: config.embeddingModel,
      embeddingError: embedding.error,
    });
    fireUsageRecorder({
      metric: "memory.commit",
      orgId: input.orgId,
      kind: input.kind,
      embeddingProvider: config.embeddingProvider,
      embeddingModel: config.embeddingModel,
      embeddingDimension: null,
      workflowId: input.workflowId,
      runId: input.runId,
      ok: false,
      error: `embedding_failed:${embedding.error}`,
      latencyMs: Date.now() - startedAt,
    });
    return { ok: false, error: "embedding_failed" };
  }

  if (!hasExpectedEmbeddingDimension(embedding)) {
    await writeCommitFailedAudit(input.orgId, "embedding_dimension_mismatch", {
      kind: input.kind,
      embeddingProvider: embedding.provider,
      embeddingModel: embedding.model,
      embeddingDimension: embedding.dimension,
      expectedDimension: MEMORY_EMBEDDING_DIMENSION,
    });
    fireUsageRecorder({
      metric: "memory.commit",
      orgId: input.orgId,
      kind: input.kind,
      embeddingProvider: embedding.provider,
      embeddingModel: embedding.model,
      embeddingDimension: embedding.dimension,
      workflowId: input.workflowId,
      runId: input.runId,
      ok: false,
      error: "embedding_failed:dimension_mismatch",
      latencyMs: Date.now() - startedAt,
    });
    return { ok: false, error: "embedding_failed" };
  }

  const retainDays =
    config.retentionDaysByKind[input.kind] ?? DEFAULT_RETENTION_DAYS[input.kind];
  const retainUntil = new Date(Date.now() + retainDays * 24 * 60 * 60 * 1000);
  const entryId = crypto.randomUUID();

  await db.insert(memoryEntries).values({
    id: entryId,
    orgId: input.orgId,
    workflowId: input.workflowId ?? null,
    runId: input.runId ?? null,
    kind: input.kind,
    content: scrubbedContent,
    embedding: embedding.embedding,
    embeddingProvider: embedding.provider,
    embeddingModel: embedding.model,
    embeddingDimension: embedding.dimension,
    metadata: metadataValue,
    retainUntil,
  });

  await writeEntryCreatedAudit(input.orgId, entryId, {
    kind: input.kind,
    bytes: Buffer.byteLength(scrubbedContent, "utf8"),
    embeddingProvider: embedding.provider,
    embeddingModel: embedding.model,
    embeddingDimension: embedding.dimension,
    workflowId: input.workflowId,
    runId: input.runId,
  });

  fireUsageRecorder({
    metric: "memory.commit",
    orgId: input.orgId,
    kind: input.kind,
    embeddingProvider: embedding.provider,
    embeddingModel: embedding.model,
    embeddingDimension: embedding.dimension,
    workflowId: input.workflowId,
    runId: input.runId,
    ok: true,
    latencyMs: Date.now() - startedAt,
  });

  return { ok: true, entryId };
}

// ─── Recall path ────────────────────────────────────────────────────────────

export type RecallMemoryInput = {
  orgId: string;
  kind?: MemoryKind;
  query: string;
};

export type MemoryRecallEntry = {
  id: string;
  kind: MemoryKind;
  content: string;
  similarity: number;
  workflowId: string | null;
  runId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
};

export type RecallMemoryResult = { entries: MemoryRecallEntry[] };

export async function recallMemory(input: RecallMemoryInput): Promise<RecallMemoryResult> {
  const startedAt = Date.now();
  const consent = await isMemoryAllowed(input.orgId);
  if (!consent.allowed) {
    fireUsageRecorder({
      metric: "memory.recall",
      orgId: input.orgId,
      kind: input.kind,
      embeddingProvider: "",
      embeddingModel: "",
      embeddingDimension: null,
      ok: false,
      error: "memory_disabled",
      latencyMs: Date.now() - startedAt,
    });
    return { entries: [] };
  }

  let config: MemoryConfig;
  try {
    config = await getMemoryConfig(input.orgId);
  } catch (error) {
    console.warn("[memory] config read failed", { orgId: input.orgId, error });
    await writeRecallFailedAudit(input.orgId, "config_unavailable", {
      kind: input.kind ?? null,
    });
    fireUsageRecorder({
      metric: "memory.recall",
      orgId: input.orgId,
      kind: input.kind,
      embeddingProvider: "",
      embeddingModel: "",
      embeddingDimension: null,
      ok: false,
      error: "config_unavailable",
      latencyMs: Date.now() - startedAt,
    });
    return { entries: [] };
  }
  const embedding = await generateEmbedding(input.query, {
    provider: config.embeddingProvider,
    model: config.embeddingModel,
    baseUrl: config.embeddingBaseUrl || undefined,
  });

  if (!embedding.ok) {
    await writeRecallFailedAudit(input.orgId, "embedding_failed", {
      kind: input.kind ?? null,
      embeddingProvider: config.embeddingProvider,
      embeddingModel: config.embeddingModel,
      embeddingError: embedding.error,
    });
    fireUsageRecorder({
      metric: "memory.recall",
      orgId: input.orgId,
      kind: input.kind,
      embeddingProvider: config.embeddingProvider,
      embeddingModel: config.embeddingModel,
      embeddingDimension: null,
      ok: false,
      error: `embedding_failed:${embedding.error}`,
      latencyMs: Date.now() - startedAt,
    });
    return { entries: [] };
  }

  if (!hasExpectedEmbeddingDimension(embedding)) {
    await writeRecallFailedAudit(input.orgId, "embedding_dimension_mismatch", {
      kind: input.kind ?? null,
      embeddingProvider: embedding.provider,
      embeddingModel: embedding.model,
      embeddingDimension: embedding.dimension,
      expectedDimension: MEMORY_EMBEDDING_DIMENSION,
    });
    fireUsageRecorder({
      metric: "memory.recall",
      orgId: input.orgId,
      kind: input.kind,
      embeddingProvider: embedding.provider,
      embeddingModel: embedding.model,
      embeddingDimension: embedding.dimension,
      ok: false,
      error: "embedding_failed:dimension_mismatch",
      latencyMs: Date.now() - startedAt,
    });
    return { entries: [] };
  }

  // orgId leads BEFORE the similarity ranking — pgvector's <=> is
  // cosine distance (smaller = more similar); we translate to a
  // similarity score (1 - distance) at the row level.
  const filters: SQL[] = [
    eq(memoryEntries.orgId, input.orgId),
    gte(memoryEntries.retainUntil, sql`now()`),
  ];
  if (input.kind) filters.push(eq(memoryEntries.kind, input.kind));

  // Bind the query embedding ONCE and reference the SELECT alias from
  // ORDER BY so Postgres / pgvector compute the cosine distance per row
  // only once. Interpolating the same `sql` chunk twice (once in SELECT,
  // once in ORDER BY) would re-emit the ~20KB literal twice on the wire
  // AND prevent the planner from sharing the computation.
  const queryEmbeddingJson = JSON.stringify(embedding.embedding);
  const distanceExpr = sql<number>`${memoryEntries.embedding} <=> ${queryEmbeddingJson}::vector`;
  let rows: Array<{
    id: string;
    kind: string;
    content: string;
    workflowId: string | null;
    runId: string | null;
    metadata: unknown;
    createdAt: Date | null;
    distance: number | string | null;
  }>;
  try {
    rows = await db
      .select({
        id: memoryEntries.id,
        kind: memoryEntries.kind,
        content: memoryEntries.content,
        workflowId: memoryEntries.workflowId,
        runId: memoryEntries.runId,
        metadata: memoryEntries.metadata,
        createdAt: memoryEntries.createdAt,
        distance: distanceExpr.as("distance"),
      })
      .from(memoryEntries)
      .where(and(...filters))
      .orderBy(sql`distance`)
      .limit(config.recallMaxEntries);
  } catch (error) {
    console.warn("[memory] recall query failed", { orgId: input.orgId, error });
    await writeRecallFailedAudit(input.orgId, "query_failed", {
      kind: input.kind ?? null,
      embeddingProvider: embedding.provider,
      embeddingModel: embedding.model,
    });
    fireUsageRecorder({
      metric: "memory.recall",
      orgId: input.orgId,
      kind: input.kind,
      embeddingProvider: embedding.provider,
      embeddingModel: embedding.model,
      embeddingDimension: embedding.dimension,
      ok: false,
      error: "query_failed",
      latencyMs: Date.now() - startedAt,
    });
    return { entries: [] };
  }

  // Trim the result list to `recallMaxBytes` AFTER the SQL `LIMIT` has
  // already bounded entry count. Carve-out by design: the first entry
  // is always included even if its content alone exceeds the byte cap
  // — recall returning *something* useful beats returning empty just
  // because one stored row is large. A future commit-time per-row byte
  // cap (paired with `metadata` jsonb's existing 8 KB ceiling) is the
  // right place to bound oversized writers, not the read path.
  const entries: MemoryRecallEntry[] = [];
  let runningBytes = 0;
  for (const row of rows) {
    const content = scrubSecretShapes(row.content);
    const rowBytes = Buffer.byteLength(content, "utf8");
    if (runningBytes + rowBytes > config.recallMaxBytes && entries.length > 0) break;
    runningBytes += rowBytes;
    const distance = typeof row.distance === "number" ? row.distance : Number(row.distance);
    entries.push({
      id: row.id,
      kind: row.kind as MemoryKind,
      content,
      similarity: Number.isFinite(distance) ? 1 - distance : 0,
      workflowId: row.workflowId,
      runId: row.runId,
      metadata: (row.metadata as Record<string, unknown> | null) ?? null,
      createdAt: row.createdAt ?? new Date(0),
    });
  }

  fireUsageRecorder({
    metric: "memory.recall",
    orgId: input.orgId,
    kind: input.kind,
    embeddingProvider: embedding.provider,
    embeddingModel: embedding.model,
    embeddingDimension: embedding.dimension,
    ok: true,
    latencyMs: Date.now() - startedAt,
  });

  return { entries };
}

// ─── Retention sweep ────────────────────────────────────────────────────────

export type DeleteExpiredMemoryInput = {
  /** When supplied, the delete is scoped to that org; otherwise it sweeps every tenant. */
  orgId?: string;
};

export type DeleteExpiredMemoryResult = {
  entriesPurged: number;
};

export async function deleteExpiredMemory(
  input: DeleteExpiredMemoryInput = {},
): Promise<DeleteExpiredMemoryResult> {
  const whereClause = input.orgId
    ? and(eq(memoryEntries.orgId, input.orgId), lte(memoryEntries.retainUntil, sql`now()`))
    : lte(memoryEntries.retainUntil, sql`now()`);

  const purged = await db.delete(memoryEntries).where(whereClause).returning({
    id: memoryEntries.id,
    orgId: memoryEntries.orgId,
    kind: memoryEntries.kind,
  });

  if (purged.length > 0) {
    const kindsAffected = Array.from(new Set(purged.map((row) => row.kind))).sort();
    const byOrg = new Map<string, number>();
    for (const row of purged) {
      byOrg.set(row.orgId, (byOrg.get(row.orgId) ?? 0) + 1);
    }
    for (const [orgId, entriesPurged] of byOrg.entries()) {
      await writeAudit(orgId, null, "memory.retention.purged", null, null, {
        entriesPurged,
        kindsAffected,
      });
    }
  }

  return { entriesPurged: purged.length };
}

// ─── Consent-revocation bulk purge ──────────────────────────────────────────

export type PurgeMemoryForOrgResult = {
  entriesPurged: number;
  kindsAffected: string[];
};

/**
 * Unconditional org-scoped delete of every `memory_entries` row for the
 * tenant. Sister to `deleteExpiredMemory({ orgId })` — same multi-tenant
 * gate, but NO `retain_until` predicate. Used by the consent-revocation
 * bulk-purge job: when an admin flips `memory.enabled` from `true` to
 * `false`, policy promises every memory row for the org is purged
 * within 7 days, regardless of per-row retention.
 *
 * Writes exactly one `memory.bulk.purged` audit row per call with
 * `{ entriesPurged, kindsAffected }` metadata. The audit row is the
 * canonical observable signal — absent rows in a window where a
 * `memory.consent.revoked` fired 7 days earlier is the operator's
 * "did the sweep actually run?" check.
 *
 * Idempotent: calling on an org with no rows is a no-op (still writes
 * the audit row with `entriesPurged: 0` so the operator can confirm
 * the handler executed; the cost is one extra audit insert per
 * "nothing to purge" call, traded for the observability win).
 */
export async function purgeMemoryForOrg(orgId: string): Promise<PurgeMemoryForOrgResult> {
  const purged = await db
    .delete(memoryEntries)
    .where(eq(memoryEntries.orgId, orgId))
    .returning({
      id: memoryEntries.id,
      kind: memoryEntries.kind,
    });

  const kindsAffected = Array.from(new Set(purged.map((row) => row.kind))).sort();
  await writeAudit(orgId, null, "memory.bulk.purged", null, null, {
    entriesPurged: purged.length,
    kindsAffected,
  });

  return { entriesPurged: purged.length, kindsAffected };
}

// ─── Audit + usage helpers (private) ─────────────────────────────────────────

async function writeAudit(
  orgId: string,
  userId: string | null,
  action: string,
  targetType: string | null,
  targetId: string | null,
  metadata: Record<string, unknown>,
): Promise<void> {
  try {
    await db.insert(auditLogs).values({
      id: crypto.randomUUID(),
      orgId,
      userId,
      action,
      targetType,
      targetId,
      metadata,
    });
  } catch (error) {
    console.warn("[memory] audit write failed", { action, error });
  }
}

async function writeEntryCreatedAudit(
  orgId: string,
  entryId: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await writeAudit(orgId, null, "memory.entry.created", "memory_entry", entryId, metadata);
}

async function writeCommitFailedAudit(
  orgId: string,
  reason: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await writeAudit(orgId, null, "memory.entry.failed", null, null, { reason, ...metadata });
}

async function writeRecallFailedAudit(
  orgId: string,
  reason: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await writeAudit(orgId, null, "memory.recall.failed", null, null, { reason, ...metadata });
}

function hasExpectedEmbeddingDimension(
  embedding: Extract<EmbeddingResult, { ok: true }>,
): boolean {
  return (
    embedding.dimension === MEMORY_EMBEDDING_DIMENSION &&
    embedding.embedding.length === MEMORY_EMBEDDING_DIMENSION
  );
}

function sanitizeMemoryMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const sanitized = sanitizeMemoryMetadataValue(metadata, new WeakSet());
  if (sanitized === null || typeof sanitized !== "object" || Array.isArray(sanitized)) {
    return {};
  }
  return sanitized as Record<string, unknown>;
}

function sanitizeMemoryMetadataValue(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === "string") return scrubSecretShapes(value);
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();

  if (Array.isArray(value)) {
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    const out = value.map((item) => sanitizeMemoryMetadataValue(item, seen));
    seen.delete(value);
    return out;
  }

  if (typeof value === "object") {
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      out[key] = SENSITIVE_KEY_PATTERN.test(key)
        ? "[redacted]"
        : sanitizeMemoryMetadataValue(nested, seen);
    }
    seen.delete(value);
    return out;
  }

  return null;
}

type FireUsageInput = {
  metric: MemoryUsageMetric;
  orgId: string;
  kind?: MemoryKind;
  embeddingProvider: string;
  embeddingModel: string;
  embeddingDimension: number | null;
  runId?: string;
  workflowId?: string;
  ok: boolean;
  error?: string;
  latencyMs: number;
};

function fireUsageRecorder(input: FireUsageInput): void {
  const recorder = getMemoryUsageRecorder();
  if (!recorder) return;
  try {
    void Promise.resolve(recorder(input)).catch((err) => {
      console.warn("[memory] usage recorder rejected", err);
    });
  } catch (err) {
    console.warn("[memory] usage recorder threw", err);
  }
}

// ─── Re-export the embedding result type so consumers don't need the AI barrel ─

export type { EmbeddingResult };
