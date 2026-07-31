/** Shared implementation details for the persistence lifecycle ports. */

import { runNodes } from "@janusly/db";
import { eq, isNull } from "drizzle-orm";

// Per-surface size caps for jsonb writes. The chokepoint's default cap
// (256 KB) is conservative for narrow surfaces (events, errors, audit) but
// too tight for state_json.output, which legitimately carries HTTP bodies
// up to the HTTP chokepoint's 1 MB cap.
export const STATE_JSON_MAX_BYTES = 1_000_000;
export const ERROR_JSON_MAX_BYTES = 64_000;
export const CHILD_ERROR_MAX_BYTES = 40_000;
export const CHILD_MESSAGE_MAX_CHARS = 4_000;

export function asPlainObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

type RunContextRow = Pick<
  typeof runNodes.$inferSelect,
  "nodeId" | "status" | "attempts" | "stateJson" | "errorJson"
>;

export function projectRunContext(
  rows: readonly RunContextRow[],
): Record<string, any> {
  return rows.reduce<Record<string, any>>((acc, row) => {
    acc[row.nodeId] = {
      status: row.status,
      attempts: row.attempts ?? 0,
      state: row.stateJson ?? {},
      output: (row.stateJson as { output?: unknown } | null)?.output ?? {},
      error: row.errorJson ?? null,
    };
    return acc;
  }, {});
}

export function recoveryClaimPredicate(recoveryClaimToken?: string) {
  return recoveryClaimToken
    ? eq(runNodes.recoveryClaimToken, recoveryClaimToken)
    : isNull(runNodes.recoveryClaimToken);
}
