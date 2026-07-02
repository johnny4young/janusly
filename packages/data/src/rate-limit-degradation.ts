/**
 * Rate-limiter degradation tracker.
 *
 * The Redis-backed limiter (``packages/data/src/rate-limit.ts``) fails
 * OPEN on Redis errors per the AGENTS.md invariant — the request still
 * goes through and a ``console.warn`` notes the blip. That posture
 * keeps a Redis outage from cascading into a wall of HTTP 429s, but it
 * is INVISIBLE to operators: no audit row, no health signal, no
 * UI chip. This module fixes the observability gap WITHOUT changing
 * the fail-open behavior.
 *
 * Used by:
 * - ``packages/data/src/rate-limit.ts`` via the optional hooks
 *   parameter to ``createRateLimiter`` — the API + worker limiter
 *   call sites both wire the production hooks at boot.
 * - ``apps/api/src/routes/health-routes.ts`` reads the snapshot for
 *   the public ``GET /health`` block + the admin
 *   ``GET /system/rate-limiter`` route.
 * - ``apps/web/src/components/OperationsPage.tsx`` polls the
 *   public snapshot on the existing fetch cadence and surfaces a
 *   chip when degraded.
 *
 * Invariants:
 * - The tracker is process-local: a multi-replica API has per-replica
 *   snapshots. That's intentional v1 — persisting the snapshot
 *   through Redis would chicken-and-egg with the very outage we're
 *   trying to surface.
 * - Audit rows are deduped per ``(bucket, day)`` — Redis outages are
 *   global infrastructure events; per-org dedup would generate spam.
 *   The dedup key intentionally OMITS ``orgId``.
 * - All audit writes are best-effort: a Postgres outage during the
 *   write is caught + logged. The in-memory snapshot still updates
 *   so ``GET /health`` stays accurate even if the audit log is down.
 * - ``orgId: "system"`` sentinel on audit rows — mirrors the
 *   established convention from the global-cron audit writes
 *   (memory retention sweep, auto-healing scanner).
 */

import { and, eq, gte, sql } from "drizzle-orm";

import { db, auditLogs } from "@janusly/db";
import { scrubSecretShapes } from "@janusly/shared/src/error-signature";
import { safePersistPayload } from "@janusly/shared/src/safe-persist";
import { recordAlertEvent } from "./alert-dispatch";

/** Per-bucket state held in-memory while the bucket is degraded. */
type DegradationState = {
  bucket: string;
  errorCount: number;
  firstObservedAt: string;
  lastObservedAt: string;
  lastError: string;
  /** Last bucket key (typically ``orgId``) seen at error time — retained for
   *  incident triage but never used as a dedup dimension. */
  lastObservedKey: string;
  /** ISO date (YYYY-MM-DD) of the latest audit emission for the dedup gate. */
  lastAuditedDay: string | null;
};

/** Public read-only snapshot consumed by ``GET /health``. */
export type RateLimiterPublicHealth = {
  healthy: boolean;
  degradedBuckets: Array<{
    /** Public-safe bucket label. Tenant-chosen aliases are collapsed. */
    bucket: string;
    errorCount: number;
    firstObservedAt: string;
    lastObservedAt: string;
  }>;
};

/** Admin snapshot — adds the Redis error strings + lastObservedKey for
 *  incident triage. Never exposed on the public ``/health`` route. */
export type RateLimiterAdminHealth = {
  healthy: boolean;
  degradedBuckets: Array<{
    bucket: string;
    errorCount: number;
    firstObservedAt: string;
    lastObservedAt: string;
    lastError: string;
    lastObservedKey: string;
  }>;
};

const SYSTEM_ORG_ID = "system";

/** Module-scoped state. Per-process. */
const state = new Map<string, DegradationState>();

function todayIsoDate(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function describeError(err: unknown): string {
  // Raw Redis errors can carry connection strings with embedded
  // credentials (``redis://:password@host:port`` shapes), bearer
  // tokens lifted from a misconfigured logger, or other secret-shaped
  // material. The audit chokepoint elsewhere in the codebase relies on
  // ``safePersistPayload`` to scrub these on write — this module
  // writes to ``audit_logs`` directly (data-layer scope, no engine
  // dep), so we scrub up-front using the same shared regex catalogue.
  // The scrub happens here once so the in-memory snapshot (admin
  // route) AND the audit row see the same redacted text.
  const raw =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : (() => {
            try {
              return JSON.stringify(err);
            } catch {
              return "unknown error";
            }
          })();
  return scrubSecretShapes(raw);
}

/**
 * Record a Redis error from the limiter hot path. Called by the
 * ``createRateLimiter`` ``onRedisError`` hook BEFORE the existing
 * ``console.warn`` + fail-open return.
 *
 * Behaviour:
 * - Increments the per-bucket error counter (always).
 * - On the FIRST error in a (bucket, day) tuple, writes a
 *   ``rate_limit.degraded`` audit row. Subsequent errors that same
 *   UTC day are deduped (no audit row, counter still increments).
 * - Day-boundary crossings re-emit the audit so a sustained outage
 *   is visible across multiple days of the audit log.
 *
 * NEVER throws — the limiter's fail-open guarantee depends on this.
 * The data layer's own ``console.warn`` is the operator-visible
 * fallback when the audit write itself fails.
 */
export async function recordRateLimiterError(
  bucket: string,
  key: string,
  error: unknown,
): Promise<void> {
  try {
    const nowIso = new Date().toISOString();
    const today = todayIsoDate();
    const existing = state.get(bucket);
    const message = describeError(error);

    const next: DegradationState = existing
      ? {
          ...existing,
          errorCount: existing.errorCount + 1,
          lastObservedAt: nowIso,
          lastError: message,
          lastObservedKey: key,
        }
      : {
          bucket,
          errorCount: 1,
          firstObservedAt: nowIso,
          lastObservedAt: nowIso,
          lastError: message,
          lastObservedKey: key,
          lastAuditedDay: null,
        };

    // Emit an audit row when we transition into a new (bucket, day):
    // either we just started degrading, or the UTC day rolled over
    // during a sustained outage. Otherwise dedupe.
    const shouldAudit = next.lastAuditedDay !== today;
    if (shouldAudit) {
      next.lastAuditedDay = today;
    }
    state.set(bucket, next);

    if (shouldAudit) {
      await writeDegradedAudit({
        bucket,
        key,
        message,
        firstObservedAt: next.firstObservedAt,
      });
    }
  } catch (err) {
    console.warn("[rate-limit] degradation tracker errored (limiter unaffected)", err);
  }
}

/**
 * Record a successful Redis call. Called by the ``createRateLimiter``
 * ``onRedisSuccess`` hook.
 *
 * Idempotent: if the bucket was NOT previously degraded, this is a
 * no-op (no audit write, no map mutation). When a previously-degraded
 * bucket sees a success, the in-memory state clears and a one-shot
 * ``rate_limit.recovered`` audit row is written.
 *
 * The optional ``_key`` argument matches the ``RateLimiterHooks``
 * contract (``onRedisSuccess: (bucket, key) => …``); recovery is
 * bucket-scoped, not key-scoped, so the value is intentionally
 * unused. Accepting it explicitly keeps the wire-up's call shape
 * honest with the declared hook signature.
 *
 * NEVER throws.
 */
export async function recordRateLimiterRecovery(bucket: string, _key?: string): Promise<void> {
  try {
    const existing = state.get(bucket);
    if (!existing) return;
    state.delete(bucket);
    await writeRecoveredAudit({
      bucket,
      firstObservedAt: existing.firstObservedAt,
      lastObservedAt: existing.lastObservedAt,
      errorCount: existing.errorCount,
    });
  } catch (err) {
    console.warn("[rate-limit] degradation tracker recovery errored", err);
  }
}

/**
 * Snapshot for the PUBLIC ``GET /health`` route. Truncates the
 * Redis error strings + the ``lastObservedKey`` to avoid leaking
 * internal connection metadata on an open route.
 */
export function getRateLimiterPublicHealth(): RateLimiterPublicHealth {
  const degradedBuckets = Array.from(state.values()).map((entry) => ({
    bucket: publicBucketLabel(entry.bucket),
    errorCount: entry.errorCount,
    firstObservedAt: entry.firstObservedAt,
    lastObservedAt: entry.lastObservedAt,
  }));
  return {
    healthy: degradedBuckets.length === 0,
    degradedBuckets,
  };
}

/**
 * Snapshot for the ADMIN ``GET /system/rate-limiter`` route. Adds the
 * Redis error string + the bucket key (typically ``orgId``) for
 * incident triage. NEVER exposed on the public ``/health`` route.
 */
export function getRateLimiterAdminHealth(): RateLimiterAdminHealth {
  const degradedBuckets = Array.from(state.values()).map((entry) => ({
    bucket: entry.bucket,
    errorCount: entry.errorCount,
    firstObservedAt: entry.firstObservedAt,
    lastObservedAt: entry.lastObservedAt,
    lastError: entry.lastError,
    lastObservedKey: entry.lastObservedKey,
  }));
  return {
    healthy: degradedBuckets.length === 0,
    degradedBuckets,
  };
}

/** Reset hook used ONLY by vitest fixtures. Don't call from prod. */
export function _resetRateLimiterDegradationForTests(): void {
  state.clear();
}

function publicBucketLabel(bucket: string): string {
  const scrubbed = scrubSecretShapes(bucket);
  if (scrubbed.startsWith("mcp_client.")) return "mcp_client";
  return scrubbed.length > 80 ? `${scrubbed.slice(0, 77)}...` : scrubbed;
}

// ─── Audit chokepoint (private) ─────────────────────────────────────────────

async function writeDegradedAudit(input: {
  bucket: string;
  key: string;
  message: string;
  firstObservedAt: string;
}): Promise<void> {
  // Belt-and-suspenders dedup against the DB: if a prior process replica
  // already wrote a row for (bucket, today) — possible under multi-replica
  // deployment — skip the second insert. The in-memory dedup already
  // covers the single-replica case; this guards against duplicate audit
  // rows when many replicas degrade together.
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  try {
    const recent = await db
      .select({ id: auditLogs.id })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.orgId, SYSTEM_ORG_ID),
          eq(auditLogs.action, "rate_limit.degraded"),
          gte(auditLogs.createdAt, since),
          sql`${auditLogs.metadata} @> ${JSON.stringify({ bucket: input.bucket })}::jsonb`,
        ),
      )
      .limit(1);
    if (recent.length > 0) return;

    await db.insert(auditLogs).values({
      id: crypto.randomUUID(),
      orgId: SYSTEM_ORG_ID,
      userId: null,
      action: "rate_limit.degraded",
      targetType: "rate_limit_bucket",
      targetId: input.bucket,
      metadata: safePersistPayload({
        bucket: input.bucket,
        firstObservedAt: input.firstObservedAt,
        lastObservedKey: input.key,
        lastError: input.message,
      }) as Record<string, unknown>,
    });

    // Fire the recovery-alerting hook so subscribed system-org policies can
    // fan out via Slack / webhook / email. Uses the `system` sentinel orgId
    // (mirrors the audit row's scoping). The DI seam is a no-op when no
    // dispatcher is registered.
    void recordAlertEvent({
      orgId: SYSTEM_ORG_ID,
      trigger: "limiter.degraded",
      payload: {
        bucket: input.bucket,
        firstObservedAt: input.firstObservedAt,
        lastError: input.message,
      },
    });
  } catch (err) {
    console.warn("[rate-limit] degraded audit write failed", { bucket: input.bucket, err });
  }
}

async function writeRecoveredAudit(input: {
  bucket: string;
  firstObservedAt: string;
  lastObservedAt: string;
  errorCount: number;
}): Promise<void> {
  try {
    await db.insert(auditLogs).values({
      id: crypto.randomUUID(),
      orgId: SYSTEM_ORG_ID,
      userId: null,
      action: "rate_limit.recovered",
      targetType: "rate_limit_bucket",
      targetId: input.bucket,
      metadata: safePersistPayload({
        bucket: input.bucket,
        firstObservedAt: input.firstObservedAt,
        lastObservedAt: input.lastObservedAt,
        errorCount: input.errorCount,
      }) as Record<string, unknown>,
    });
  } catch (err) {
    console.warn("[rate-limit] recovered audit write failed", { bucket: input.bucket, err });
  }
}
