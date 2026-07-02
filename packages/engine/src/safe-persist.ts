/**
 * Re-export shim for the safe-persistence chokepoint, which now lives in
 * `@janusly/shared/src/safe-persist` so the data layer's system-audit
 * writers can reach it without depending on the engine. Every
 * engine-internal `./safe-persist` import keeps working through this
 * module; new engine code may import either path.
 *
 * See the shared module for the full contract (value redaction →
 * sensitive-key redaction → size bounding) and the list of consumers.
 * Don't write jsonb to `run_events.payload`, `run_nodes.state_json` /
 * `error_json`, `dead_letters.error_json`, or `audit_logs.metadata`
 * without going through `safePersistPayload`.
 */

export {
  safePersistPayload,
  SENSITIVE_KEY_PATTERN,
  type SafePersistOptions,
} from "@janusly/shared/src/safe-persist";
