/**
 * Persistence chokepoint for jsonb writes that may carry secret values,
 * sensitive keys, or arbitrarily large payloads. Stacks three sanitizers
 * into a single function so every jsonb-bound write goes through the same
 * gate:
 *
 *   1. **Value-based redaction** — when the caller provides
 *      `redactedValues`, string occurrences are replaced with
 *      `"[redacted]"` via `redactValues` (moved here from the engine's
 *      `template.ts` so the data layer can reach it without an engine
 *      dependency). Defense in depth on top of any pre-write redaction
 *      the runtime already does inside `executeNode` — most engine paths
 *      have already scrubbed by the time their payload reaches this
 *      helper.
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
 * Lives in `@janusly/shared` (deep import, NOT the barrel — it reads
 * `process.env` for the cap override, and the barrel is consumed by the
 * browser bundle) so both the engine AND the data layer's system-audit
 * writers can reach the chokepoint without a dependency cycle
 * (`data` must not depend on `engine`).
 *
 * Used by:
 *   - `packages/engine/src/safe-persist.ts` — re-export shim; every
 *     engine-internal import path is unchanged.
 *   - `packages/engine/src/persistence.ts` — `appendEvent`,
 *     `markNodeWaiting`, `markNodeSkipped`, `markNodeSucceeded`,
 *     `markNodeFailed` (via the shim).
 *   - `packages/engine/src/adapters/dead-letter-queue.ts` — DLQ row
 *     `errorJson` / `workflowJson` / `nodeJson` (via the shim).
 *   - `apps/api/src/audit.ts` — `audit()` writes to `audit_logs.metadata`.
 *   - `packages/data/src/rate-limit-degradation.ts`,
 *     `packages/data/src/memoryEntriesRepo.ts`,
 *     `packages/data/src/autoHealingRepo.ts` — system-audit metadata
 *     writers that previously wrote raw jsonb because they could not
 *     import the engine.
 *
 * Don't write jsonb to `run_events.payload`, `run_nodes.state_json` /
 * `error_json`, `dead_letters.error_json`, or `audit_logs.metadata`
 * without going through this helper: the safe path is intentionally
 * narrower than the schema's `jsonb` accepts, and the schema columns are
 * unbounded by Postgres.
 */

import { SENSITIVE_KEY_PATTERN } from "./sensitive-keys";

/**
 * Field-name regex for sensitive-key redaction. Matches whole keys and
 * common separator/camel-case suffixes case-insensitively so the recursive
 * walker scrubs `Authorization`, `secretKey`, `password_hash`, `api_key`,
 * etc. without false-positive matches on substrings like `not-a-secret` or
 * lowercase words like `tokenizer`.
 *
 * Source of truth stays in `./sensitive-keys` so the structural workflow
 * diff can match against the same catalogue; re-exported here (and from
 * the engine shim) for import convenience.
 */
export { SENSITIVE_KEY_PATTERN };

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Replace every string occurrence of each `redactedValues` entry with
 * `"[redacted]"`, walking arrays and plain records recursively. Generic so
 * callers keep their input type. Moved here from the engine's
 * `template.ts` (which re-exports it) so `safePersistPayload` and the
 * data layer share one implementation.
 */
export function redactValues<T>(value: T, redactedValues: string[]): T {
  if (redactedValues.length === 0) return value;
  if (typeof value === "string") {
    let next: string = value;
    for (const secret of redactedValues) {
      if (!secret) continue;
      next = next.split(secret).join("[redacted]");
    }
    return next as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValues(item, redactedValues)) as T;
  }
  if (isPlainRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactValues(item, redactedValues)]),
    ) as T;
  }
  return value;
}

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
  const originalBytes = utf8ByteLength(json);
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

/**
 * Detect a `ReadableStream` (Web Streams) or an async-iterable that wraps
 * one. Returns `true` only for live stream-shaped values that can't be
 * JSON-serialized and would either throw or produce useless output if
 * persisted as-is. Defense-in-depth — the streaming-mode HTTP executor
 * always pre-consumes into a preview before returning, so this guard
 * should only trip on a regression that lets a live stream escape its
 * executor invocation.
 */
function isReadableStreamLike(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  // Web Streams ReadableStream — covers both the Node global and the
  // `node:stream/web` import.
  if (typeof ReadableStream !== "undefined" && value instanceof ReadableStream) return true;
  // Structural check for ReadableStream-shaped values (cross-realm /
  // polyfilled instances): both `getReader` AND `tee` are required so we
  // don't false-positive on user objects that happen to expose just one.
  const v = value as { getReader?: unknown; tee?: unknown };
  return typeof v.getReader === "function" && typeof v.tee === "function";
}

function streamSentinel(): { __stream: true; note: string } {
  return {
    __stream: true,
    note: "ReadableStream not persisted — consume within the executor (see consumeStreamToPreview)",
  };
}

function normalizeJsonValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function" || typeof value === "symbol") return undefined;
  if (!value || typeof value !== "object") return value;

  // Stream guard — substitute BEFORE we touch any field, so a wrapping
  // executor object containing both a stream and other keys doesn't drop
  // its siblings just because the stream itself can't be enumerated.
  if (isReadableStreamLike(value)) return streamSentinel();

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

// Byte helpers use TextEncoder (not node:buffer) so this module stays
// loadable from any runtime a shared consumer might bundle for.
const utf8Encoder = new TextEncoder();

function utf8ByteLength(value: string): number {
  return utf8Encoder.encode(value).length;
}

function sliceUtf8Bytes(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  let used = 0;
  let out = "";
  for (const char of value) {
    const charBytes = utf8ByteLength(char);
    if (used + charBytes > maxBytes) break;
    out += char;
    used += charBytes;
  }
  return out;
}

function envMaxBytes(): number | null {
  if (typeof process === "undefined" || !process.env) return null;
  const raw = process.env.JANUSLY_PERSIST_MAX_BYTES;
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}
