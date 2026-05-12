/**
 * Process-wide constants and env-driven config for the API server.
 * Read once at module load; the api server itself wires them into
 * `createApiServer`.
 *
 * Used by `apps/api/src/index.ts` (boot path) and the per-surface route
 * modules in `apps/api/src/routes/*` that need to share an upper bound
 * (e.g. `MAX_JSON_BODY_BYTES`, `RUN_EVENTS_*_LIMIT`).
 */

import { runOpenStatusValues, runTerminalStatusValues } from "@janusly/shared/src/status";

export const PORT = Number(process.env.PORT || 3001);
export const MAX_JSON_BODY_BYTES = Number(process.env.API_MAX_JSON_BODY_BYTES || 1_048_576);
export const API_REQUEST_TIMEOUT_MS = readPositiveIntegerEnv("API_REQUEST_TIMEOUT_MS", 60_000);
export const API_KEEP_ALIVE_TIMEOUT_MS = readPositiveIntegerEnv("API_KEEP_ALIVE_TIMEOUT_MS", 5_000);
export const API_HEADERS_TIMEOUT_MS = readPositiveIntegerEnv("API_HEADERS_TIMEOUT_MS", 65_000);
export const API_SHUTDOWN_GRACE_MS = readPositiveIntegerEnv("API_SHUTDOWN_GRACE_MS", 10_000);
export const AUDIT_PAGE_SIZE = 100;
export const RUN_EVENTS_DEFAULT_LIMIT = 200;
export const RUN_EVENTS_MAX_LIMIT = 500;
export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const OPEN_RUN_STATUS_SET = new Set<string>(runOpenStatusValues);
export const FAILED_RUN_STATUS_SET = new Set<string>(runTerminalStatusValues.filter((status) => status !== "succeeded"));

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1) return fallback;
  return Math.floor(value);
}
