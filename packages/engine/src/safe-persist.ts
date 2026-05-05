/**
 * Persistence chokepoint for jsonb writes that may carry secret values,
 * sensitive keys, or arbitrarily large payloads. Stacks three sanitizers
 * into a single function so every jsonb-bound write goes through the same
 * gate:
 *
 *   1. **Value-based redaction** — when the caller provides
 *      `redactedValues`, string occurrences are replaced with
 *      `"[redacted]"` via the existing `redactValues` from `template.ts`.
 *      Defense in depth on top of any pre-write redaction the runtime
 *      already does inside `executeNode` — most engine paths have
 *      already scrubbed by the time their payload reaches this helper.
 *
 *   2. **Sensitive-key redaction** — recursively rewrites object keys
 *      matching a closed regex (`secret*`, `password*`, `token*`,
 *      `api*key`, `authorization`, `cookie`, `x-api-key`,
 *      `client*secret`, `private*key`) to `"[redacted]"`. Catches the
 *      case where a payload field is named `Authorization` even when its
 *      value isn't in the per-run `redactedValues` list (e.g. an
 *      upstream's response echoing the request token back).
 *
 *   3. **Size bounding** — JSON-stringifies the post-redaction value to
 *      measure byte length. Over the cap, the payload is replaced with
 *      a `__truncated` sentinel that preserves a human-readable preview
 *      and the original byte count so the operator can spot
 *      "this run wrote 3.2 MB into a 256 KB cap" in the row. Pass
 *      `maxBytes: Number.POSITIVE_INFINITY` to skip truncation entirely
 *      (the DLQ replay path uses this for the workflow + node JSONs it
 *      needs verbatim to reconstruct the failed job).
 *
 * Used by:
 *   - `packages/engine/src/persistence.ts` — `appendEvent`,
 *     `markNodeWaiting`, `markNodeSkipped`, `markNodeSucceeded`,
 *     `markNodeFailed`.
 *   - `packages/engine/src/adapters/dead-letter-queue.ts` — DLQ row
 *     `errorJson` / `workflowJson` / `nodeJson`.
 *   - `apps/api/src/index.ts` — `audit()` writes to `audit_logs.metadata`.
 *
 * Don't write jsonb to those columns without going through this helper:
 * the safe path is intentionally narrower than the schema's `jsonb`
 * accepts, and the schema columns are unbounded by Postgres.
 */

import { redactValues } from "./template";

import { SENSITIVE_KEY_PATTERN } from "@janusly/shared/src/sensitive-keys";

/**
 * Field-name regex for sensitive-key redaction. Matches whole keys and
 * common separator/camel-case suffixes case-insensitively so the recursive
 * walker scrubs `Authorization`, `secretKey`, `password_hash`, `api_key`,
 * etc. without false-positive matches on substrings like `not-a-secret` or
 * lowercase words like `tokenizer`.
 *
 * Re-exported from `@janusly/shared` so the structural workflow diff
 * (browser-side, can't reach into `@janusly/engine`) can match against
 * the same source of truth. Lives in `shared` because adding a new key
 * shape there should improve redaction at write time AND secret-ref
 * tagging at diff time without one layer depending on the other.
 */
export { SENSITIVE_KEY_PATTERN };

/**
 * Default cap for `safePersistPayload`. 256 KB is enough for typical run
 * events (sub-KB in practice) and decision rankings (low-KB), but
 * deliberately tight so a runaway HTTP body or AI tool output that
 * sneaks past the engine-layer caps gets truncated with a sentinel here.
 */
const DEFAULT_MAX_BYTES = 256_000;

/** Per-call options for `safePersistPayload`. */
export type SafePersistOptions = {
  /** Per-run resolved-secret values to scrub from string occurrences. Optional — engine paths often pre-redact via `executeNode`, so the chokepoint's value-redaction layer is defense in depth. */
  redactedValues?: string[];
  /** Override the default 256 KB cap. Pass `Number.POSITIVE_INFINITY` to skip the truncation step entirely (used by the DLQ workflow/node JSONs that need to be replay-able byte-for-byte). */
  maxBytes?: number;
};

/**
 * Run a payload through the value/key/size sanitizer stack and return a
 * shape safe to persist as jsonb. Pure function — never throws. Values that
 * JSON cannot represent directly (for example `bigint` and circular refs)
 * are normalized into strings before the byte cap is measured.
 */
export function safePersistPayload(payload: unknown, options: SafePersistOptions = {}): unknown {
  // 1. Value-based redaction — only runs when the caller actually has a
  //    redactedValues list. Most engine writes don't (they pre-redacted
  //    in `executeNode`); audit() doesn't (no resolved-secret context).
  let working: unknown = normalizeJsonValue(payload);
  if (options.redactedValues?.length) {
    working = redactValues(working, options.redactedValues);
  }

  // 2. Sensitive-key redaction — always on. Catches `Authorization`-named
  //    fields whose value happens not to be in the redactedValues list.
  working = normalizeJsonValue(redactSensitiveKeys(working));

  // 3. Size bounding — measured against the post-redaction shape so
  //    huge-but-redacted payloads still get truncated. `JSON.stringify`
  //    can return `undefined` for some inputs (top-level `undefined`,
  //    function-only objects); treat that as "nothing to measure" and
  //    pass through.
  const cap = options.maxBytes ?? envMaxBytes() ?? DEFAULT_MAX_BYTES;
  if (!Number.isFinite(cap) || cap <= 0) return working;
  const json = stringifyJsonSafe(working);
  if (json === undefined) return working;
  const originalBytes = Buffer.byteLength(json, "utf8");
  if (originalBytes <= cap) return working;

  // Sentinel: well-formed JSON the operator can spot in raw rows. The
  // preview slice gives enough leading shape characters to identify
  // what kind of payload was over-large without inflating the row back.
  return {
    __truncated: true,
    originalBytes,
    maxBytes: cap,
    preview: sliceUtf8Bytes(json, Math.floor(cap / 2)),
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

  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    const errorRecord = value as Error & Record<string, unknown>;
    const normalized = normalizeJsonValue({
      name: value.name,
      message: value.message,
      stack: value.stack,
      ...Object.fromEntries(Object.entries(errorRecord)),
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

function envMaxBytes(): number | null {
  const raw = process.env.JANUSLY_PERSIST_MAX_BYTES;
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}
