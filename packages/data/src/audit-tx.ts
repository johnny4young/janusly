/**
 * Transaction-bound entity+audit chokepoint.
 *
 * Wraps `db.transaction(...)` and gives the handler two things:
 *  1. The `tx` handle for entity inserts / updates / upserts.
 *  2. An `audit` function bound to the same `tx` so the audit row
 *     lands inside the transaction — failure rolls everything back.
 *
 * The promise the helper returns NEVER rejects. On any throw inside
 * the handler (entity insert error, audit insert error, programmer
 * mistake), the transaction rolls back and the helper returns
 * `{ ok: false, error }`. Callers keep their existing error-handling
 * shape without a separate try/catch.
 *
 * Convention vs the module-level `audit()`:
 *   The module-level `audit()` chokepoint in `apps/api/src/audit.ts`
 *   writes via the non-transactional `db` handle and intentionally
 *   swallows failures (audit drops shouldn't break the route response
 *   on the happy path). When you need the audit row to be atomic
 *   with an entity write, route through THIS helper instead. The
 *   handler argument's `audit` parameter shadows the module-level
 *   import within the lambda scope — using the parameter is the
 *   convention; the type system can't structurally prevent a handler
 *   from re-importing and calling the module-level function, so the
 *   guard is naming + this docblock.
 *
 * Used by:
 *  - `packages/data/src/memoryEntriesRepo.ts` (`commitMemory`) —
 *    memory_entries insert + `memory.entry.created` audit.
 *  - `apps/api/src/routes/sso-routes.ts` (SSO callback) —
 *    `upsertMembership` + `auth.sso.login` audit.
 */

import { db, auditLogs } from "@janusly/db";
import { SENSITIVE_KEY_PATTERN } from "@janusly/shared/src/sensitive-keys";

// Keep tx-bound audit rows aligned with apps/api/src/audit.ts without
// importing from the API or engine layers. Audit metadata is human-read
// and must stay redacted + bounded before it reaches jsonb.
const AUDIT_METADATA_MAX_BYTES = 64_000;

/** Drizzle transaction handle, extracted from the callback signature. */
export type DrizzleTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Either the module-level `db` or an active transaction. Repo helpers
 *  that accept this union can be invoked from inside `withAuditTx` and
 *  participate in the surrounding transaction. */
export type DbOrTx = typeof db | DrizzleTx;

export type TxAuditInput = {
  orgId: string;
  userId: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  metadata?: unknown;
};

export type TxAudit = (input: TxAuditInput) => Promise<void>;

export type AuditTxResult<T> =
  | { ok: true; result: T }
  | { ok: false; error: string };

/**
 * Run an entity write + an audit row in one Drizzle transaction. If
 * any operation inside `handler` throws — including the bound `audit`
 * call — the entire transaction rolls back so the `audit_logs` row
 * can NEVER outlive a rolled-back entity write.
 *
 * The handler receives:
 *  - `tx`: the transaction handle (use for `tx.insert(...)` /
 *    `tx.update(...)` / `tx.select(...)`).
 *  - `audit`: a function bound to the same transaction. Calling it
 *    issues a single `INSERT INTO audit_logs` inside the tx.
 *
 * Returns `{ ok: true; result } | { ok: false; error }` so callers
 * keep their existing envelope shape; the helper never re-throws.
 */
export async function withAuditTx<T>(
  handler: (tx: DrizzleTx, audit: TxAudit) => Promise<T>,
): Promise<AuditTxResult<T>> {
  try {
    const result = await db.transaction(async (tx) => {
      const audit: TxAudit = async (input) => {
        await tx.insert(auditLogs).values({
          id: crypto.randomUUID(),
          orgId: input.orgId,
          userId: input.userId,
          action: input.action,
          targetType: input.targetType ?? null,
          targetId: input.targetId ?? null,
          metadata: sanitizeAuditMetadata(input.metadata),
        });
      };
      return handler(tx, audit);
    });
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function sanitizeAuditMetadata(metadata: unknown): unknown {
  const redacted = redactSensitiveKeys(normalizeJsonValue(metadata ?? {}));
  const json = stringifyJsonSafe(redacted);
  if (json === undefined) return redacted;
  const originalBytes = Buffer.byteLength(json, "utf8");
  if (originalBytes <= AUDIT_METADATA_MAX_BYTES) return redacted;
  return {
    __truncated: true,
    originalBytes,
    maxBytes: AUDIT_METADATA_MAX_BYTES,
    preview: sliceUtf8Bytes(json, Math.floor(AUDIT_METADATA_MAX_BYTES / 2)),
  };
}

function redactSensitiveKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSensitiveKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        SENSITIVE_KEY_PATTERN.test(key) ? "[redacted]" : redactSensitiveKeys(item),
      ]),
    );
  }
  return value;
}

function normalizeJsonValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function" || typeof value === "symbol") return undefined;
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return "[circular]";
  seen.add(value);

  if (value instanceof Date) {
    seen.delete(value);
    return value.toISOString();
  }
  if (value instanceof Error) {
    const normalized = normalizeJsonValue({
      name: value.name,
      message: value.message,
      stack: value.stack,
      ...Object.fromEntries(Object.entries(value as Error & Record<string, unknown>)),
    }, seen);
    seen.delete(value);
    return normalized;
  }
  if (Array.isArray(value)) {
    const normalized = value.map((item) => normalizeJsonValue(item, seen));
    seen.delete(value);
    return normalized;
  }

  const normalized = Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => [key, normalizeJsonValue(item, seen)])
      .filter(([, item]) => item !== undefined),
  );
  seen.delete(value);
  return normalized;
}

function stringifyJsonSafe(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify(String(value));
  }
}

function sliceUtf8Bytes(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  let used = 0;
  let out = "";
  for (const char of value) {
    const charBytes = Buffer.byteLength(char, "utf8");
    if (used + charBytes > maxBytes) break;
    out += char;
    used += charBytes;
  }
  return out;
}
